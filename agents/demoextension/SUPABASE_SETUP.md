# DemoBuddy Pro - Supabase Setup Guide

## Overview

This guide walks you through setting up Supabase for DemoBuddy Pro features:
- User authentication (email, Google OAuth)
- Cloud sync for talk tracks
- Subscription management via Stripe

## Step 1: Create Supabase Project

1. Go to [supabase.com](https://supabase.com) and sign up/login
2. Click "New Project"
3. Choose your organization
4. Set project details:
   - **Name:** `demobuddy` (or your preference)
   - **Database Password:** Generate a strong password (save it!)
   - **Region:** Choose closest to your users
5. Click "Create new project" and wait for setup (~2 minutes)

## Step 2: Run Database Schema

1. In your Supabase dashboard, go to **SQL Editor**
2. Click "New query"
3. Copy the contents of `supabase/schema.sql` and paste it
4. Click "Run" (or Cmd/Ctrl + Enter)
5. You should see "Success. No rows returned" for each statement

## Step 3: Configure Authentication

### Email Auth (enabled by default)
1. Go to **Authentication** > **Providers**
2. Email should already be enabled
3. Optional: Disable "Confirm email" for easier testing

### Google OAuth (recommended)
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or use existing)
3. Go to **APIs & Services** > **Credentials**
4. Click **Create Credentials** > **OAuth Client ID**
5. Application type: **Web application**
6. Add authorized redirect URI:
   ```
   https://YOUR_PROJECT_ID.supabase.co/auth/v1/callback
   ```
7. Copy the **Client ID** and **Client Secret**
8. In Supabase, go to **Authentication** > **Providers** > **Google**
9. Enable it and paste your credentials

## Step 4: Get API Keys

1. In Supabase, go to **Settings** > **API**
2. Copy these values:
   - **Project URL** (e.g., `https://xxxxx.supabase.co`)
   - **anon public** key (safe to use in frontend)

## Step 5: Configure Extension

1. Open `config.js` in the extension folder
2. Fill in your values:

```javascript
const DEMOBUDDY_CONFIG = {
  SUPABASE_URL: 'https://YOUR_PROJECT_ID.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...your-key',
  
  // ... rest of config
};
```

## Step 6: Set Up Stripe (for Payments)

### Create Stripe Account
1. Go to [stripe.com](https://stripe.com) and create an account
2. Complete verification (required for live payments)

### Create Products
1. Go to **Products** in Stripe Dashboard
2. Click "Add product"
3. Create **DemoBuddy Pro Monthly**:
   - Name: `DemoBuddy Pro`
   - Price: `$10.00` / month (recurring)
   - Save and copy the **Price ID** (starts with `price_`)
4. Create **DemoBuddy Pro Annual**:
   - Name: `DemoBuddy Pro Annual`
   - Price: `$99.00` / year (recurring)
   - Copy the **Price ID**

### Add to Config
```javascript
const DEMOBUDDY_CONFIG = {
  // ... Supabase config ...
  
  STRIPE_PUBLISHABLE_KEY: 'pk_test_xxxxx', // or pk_live_ for production
  STRIPE_PRICE_MONTHLY: 'price_xxxxx',
  STRIPE_PRICE_ANNUAL: 'price_xxxxx',
};
```

## Step 7: Create Stripe Webhook (Edge Function)

You'll need a Supabase Edge Function to handle Stripe webhooks. Create this file:

### `supabase/functions/stripe-webhook/index.ts`

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import Stripe from 'https://esm.sh/stripe@11.1.0?target=deno'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') as string, {
  apiVersion: '2022-11-15',
})

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') as string,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') as string
)

serve(async (req) => {
  const signature = req.headers.get('stripe-signature')
  const body = await req.text()
  
  let event
  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature!,
      Deno.env.get('STRIPE_WEBHOOK_SECRET')!
    )
  } catch (err) {
    return new Response(`Webhook Error: ${err.message}`, { status: 400 })
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object
      const userId = session.client_reference_id
      const subscriptionId = session.subscription
      const customerId = session.customer
      
      await supabase
        .from('profiles')
        .update({
          subscription_status: 'pro',
          subscription_id: subscriptionId,
          customer_id: customerId,
        })
        .eq('id', userId)
      break
    }
    
    case 'customer.subscription.deleted': {
      const subscription = event.data.object
      
      await supabase
        .from('profiles')
        .update({
          subscription_status: 'cancelled',
          subscription_ends_at: new Date(subscription.current_period_end * 1000),
        })
        .eq('subscription_id', subscription.id)
      break
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
```

### Deploy the Edge Functions
```bash
# Deploy all Stripe-related functions
supabase functions deploy stripe-webhook
supabase functions deploy create-checkout
supabase functions deploy billing-portal
```

The edge functions:
- **stripe-webhook**: Handles Stripe webhook events (subscription changes)
- **create-checkout**: Creates Stripe checkout sessions for upgrades
- **billing-portal**: Creates Stripe billing portal sessions for subscription management

### Add Webhook in Stripe
1. Go to **Developers** > **Webhooks** in Stripe
2. Click "Add endpoint"
3. URL: `https://YOUR_PROJECT_ID.supabase.co/functions/v1/stripe-webhook`
4. Select events:
   - `checkout.session.completed`
   - `customer.subscription.deleted`
   - `customer.subscription.updated`
5. Copy the **Webhook Signing Secret**
6. Add to Supabase Edge Function secrets:
   ```bash
   supabase secrets set STRIPE_SECRET_KEY=sk_xxx
   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_xxx
   ```

## Step 8: Test Everything

### Test Auth
1. Load the extension
2. Open the options page
3. Try signing up with email
4. Check Supabase **Authentication** > **Users** to see the new user

### Test Cloud Sync (after upgrade)
1. Create some talk tracks
2. Sign in as a Pro user (manually set in Supabase for testing)
3. Click "Sync Now"
4. Check Supabase **Table Editor** > **tracks** to see synced data

### Test Payments
1. Use Stripe test mode
2. Test card: `4242 4242 4242 4242` (any future date, any CVC)
3. Complete checkout
4. Verify webhook updates user's subscription_status

## File Structure

```
demoextension/
├── config.js                    # Configuration (add your keys here)
├── supabase-cloud-service.js    # Supabase API client
├── auth-ui.js                   # Authentication UI component
├── auth-ui.css                  # Auth UI styles
├── indexed-db-storage.js        # Local IndexedDB storage
├── storage-manager-v2.js        # Unified storage manager
└── supabase/
    ├── schema.sql               # Database schema
    └── functions/
        └── stripe-webhook/      # Stripe webhook handler
```

## Security Checklist

- [ ] Never commit `config.js` with real keys to public repos
- [ ] Use environment variables in production
- [ ] Enable Row Level Security (RLS) on all tables (done in schema)
- [ ] Use `anon` key in frontend, never `service_role` key
- [ ] Verify Stripe webhook signatures
- [ ] Set up proper CORS in Supabase if needed

## Troubleshooting

### "Not authenticated" errors
- Check if session is stored in chrome.storage.local
- Try signing out and back in
- Check browser console for token refresh errors

### Sync not working
- Verify user has `subscription_status = 'pro'` in profiles table
- Check Supabase logs for errors
- Ensure RLS policies are correct

### OAuth not redirecting back
- Verify redirect URL in Google Cloud Console matches Supabase
- Check Chrome identity permissions in manifest.json

## Next Steps

1. Set up your Supabase project
2. Run the schema SQL
3. Configure `config.js` with your keys
4. Test authentication locally
5. Set up Stripe for payments
6. Deploy and test the webhook
7. Launch! 🚀
