// Supabase Edge Function: Create Stripe Checkout Session
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Use Stripe via fetch API instead of SDK (avoids Deno compatibility issues)
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') as string

async function createStripeCheckout(customerId: string, priceId: string, userId: string, origin: string) {
  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      'customer': customerId,
      'client_reference_id': userId,
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'mode': 'subscription',
      'success_url': `${origin}?checkout=success`,
      'cancel_url': `${origin}?checkout=cancelled`,
      'subscription_data[metadata][supabase_user_id]': userId,
    }).toString(),
  })
  return response.json()
}

async function createStripeCustomer(email: string, userId: string) {
  const response = await fetch('https://api.stripe.com/v1/customers', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      'email': email,
      'metadata[supabase_user_id]': userId,
    }).toString(),
  })
  return response.json()
}

const supabaseUrl = Deno.env.get('SUPABASE_URL') as string
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') as string

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: corsHeaders })
  }

  try {
    // Get the user from the Authorization header
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'No authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey)
    
    // Verify the JWT and get the user
    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Get the price ID from the request
    const { priceId } = await req.json()
    if (!priceId) {
      return new Response(JSON.stringify({ error: 'Price ID required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Check if user already has a Stripe customer ID
    const { data: profile } = await supabase
      .from('profiles')
      .select('customer_id')
      .eq('id', user.id)
      .single()

    let customerId = profile?.customer_id

    // Create a new customer if needed
    if (!customerId) {
      const customer = await createStripeCustomer(user.email!, user.id)
      if (customer.error) {
        throw new Error(customer.error.message || 'Failed to create customer')
      }
      customerId = customer.id

      // Save customer ID to profile
      await supabase
        .from('profiles')
        .update({ customer_id: customerId })
        .eq('id', user.id)
    }

    // Create checkout session
    const origin = req.headers.get('origin') || 'https://example.com'
    const session = await createStripeCheckout(customerId, priceId, user.id, origin)
    
    if (session.error) {
      throw new Error(session.error.message || 'Failed to create checkout session')
    }

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('Checkout error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
