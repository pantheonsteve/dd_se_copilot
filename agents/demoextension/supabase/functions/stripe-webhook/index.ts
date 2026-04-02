// Supabase Edge Function: Stripe Webhook Handler
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL') as string
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') as string
const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') as string

// Manual Stripe signature verification (avoids SDK compatibility issues)
async function verifyStripeSignature(payload: string, signature: string, secret: string): Promise<boolean> {
  const parts = signature.split(',')
  const timestamp = parts.find(p => p.startsWith('t='))?.split('=')[1]
  const v1Signature = parts.find(p => p.startsWith('v1='))?.split('=')[1]
  
  if (!timestamp || !v1Signature) {
    return false
  }
  
  // Check timestamp is within 5 minutes
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - parseInt(timestamp)) > 300) {
    return false
  }
  
  // Compute expected signature
  const signedPayload = `${timestamp}.${payload}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signedPayload)
  )
  const expectedSignature = Array.from(new Uint8Array(signatureBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  
  return expectedSignature === v1Signature
}

serve(async (req) => {
  const signature = req.headers.get('stripe-signature')
  const body = await req.text()
  
  // Verify signature if secret is set
  if (webhookSecret && signature) {
    const isValid = await verifyStripeSignature(body, signature, webhookSecret)
    if (!isValid) {
      console.error('Invalid webhook signature')
      return new Response('Invalid signature', { status: 400 })
    }
  }
  
  let event
  try {
    event = JSON.parse(body)
  } catch (err) {
    console.error('Failed to parse webhook body:', err)
    return new Response('Invalid JSON', { status: 400 })
  }
  
  console.log('Received webhook event:', event.type)
  
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object
      const userId = session.client_reference_id
      const subscriptionId = session.subscription
      const customerId = session.customer
      
      console.log('Checkout completed for user:', userId)
      
      if (!userId) {
        console.error('No client_reference_id in checkout session')
        break
      }
      
      const { error } = await supabase
        .from('profiles')
        .update({
          subscription_status: 'pro',
          subscription_id: subscriptionId,
          customer_id: customerId,
        })
        .eq('id', userId)
      
      if (error) {
        console.error('Failed to update profile:', error)
      } else {
        console.log('Successfully updated user to pro:', userId)
      }
      break
    }
    
    case 'customer.subscription.deleted': {
      const subscription = event.data.object
      
      console.log('Subscription deleted:', subscription.id)
      
      const { error } = await supabase
        .from('profiles')
        .update({
          subscription_status: 'cancelled',
          subscription_ends_at: new Date(subscription.current_period_end * 1000).toISOString(),
        })
        .eq('subscription_id', subscription.id)
      
      if (error) {
        console.error('Failed to update subscription status:', error)
      }
      break
    }
    
    case 'customer.subscription.updated': {
      const subscription = event.data.object
      const status = subscription.status
      
      console.log('Subscription updated:', subscription.id, status)
      
      // Map Stripe status to our status
      let newStatus = 'pro'
      if (status === 'canceled' || status === 'unpaid') {
        newStatus = 'cancelled'
      } else if (status === 'past_due') {
        newStatus = 'pro' // Keep pro but could add a warning
      }
      
      await supabase
        .from('profiles')
        .update({ subscription_status: newStatus })
        .eq('subscription_id', subscription.id)
      break
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
