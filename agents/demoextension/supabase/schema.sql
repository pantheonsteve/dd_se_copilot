-- DemoBuddy Supabase Schema
-- Run this in your Supabase SQL Editor

-- ============================================
-- PROFILES TABLE (extends Supabase auth.users)
-- ============================================
CREATE TABLE public.profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  email TEXT,
  full_name TEXT,
  avatar_url TEXT,
  
  -- Subscription status
  subscription_status TEXT DEFAULT 'free' CHECK (subscription_status IN ('free', 'pro', 'team', 'cancelled')),
  subscription_id TEXT, -- Stripe subscription ID
  customer_id TEXT, -- Stripe customer ID
  subscription_ends_at TIMESTAMPTZ,
  
  -- Usage tracking
  track_count INTEGER DEFAULT 0,
  last_sync_at TIMESTAMPTZ,
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- TRACKS TABLE
-- ============================================
CREATE TABLE public.tracks (
  id BIGINT PRIMARY KEY,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  
  -- Track content
  title TEXT,
  category TEXT DEFAULT 'Other',
  url_pattern TEXT NOT NULL,
  content TEXT,
  html_backup TEXT,
  tags TEXT[] DEFAULT '{}',
  
  -- Organization
  "order" INTEGER DEFAULT 0,
  customer_id TEXT, -- Reference to customer (stored as JSON in metadata for flexibility)
  source TEXT DEFAULT 'local', -- 'local', 'pack', 'cloud-merge'
  original_id TEXT, -- For tracks from packs
  
  -- Versioning
  version TEXT DEFAULT '1.0.0',
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_synced_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Sync metadata
  is_deleted BOOLEAN DEFAULT FALSE, -- Soft delete for sync
  deleted_at TIMESTAMPTZ
);

-- Index for faster queries
CREATE INDEX idx_tracks_user_id ON public.tracks(user_id);
CREATE INDEX idx_tracks_user_url ON public.tracks(user_id, url_pattern);
CREATE INDEX idx_tracks_updated ON public.tracks(user_id, updated_at);

-- ============================================
-- METADATA TABLE (customers, personas, categories, etc.)
-- ============================================
CREATE TABLE public.user_metadata (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(user_id, key)
);

CREATE INDEX idx_metadata_user_key ON public.user_metadata(user_id, key);

-- ============================================
-- SYNC LOG (for debugging and conflict resolution)
-- ============================================
CREATE TABLE public.sync_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  action TEXT NOT NULL, -- 'push', 'pull', 'conflict'
  track_count INTEGER,
  status TEXT, -- 'success', 'partial', 'failed'
  error_message TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sync_log_user ON public.sync_log(user_id, created_at DESC);

-- ============================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================

-- Enable RLS on all tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_log ENABLE ROW LEVEL SECURITY;

-- Profiles: Users can only read/update their own profile
CREATE POLICY "Users can view own profile" 
  ON public.profiles FOR SELECT 
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" 
  ON public.profiles FOR UPDATE 
  USING (auth.uid() = id);

-- Tracks: Users can only access their own tracks
CREATE POLICY "Users can view own tracks" 
  ON public.tracks FOR SELECT 
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own tracks" 
  ON public.tracks FOR INSERT 
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own tracks" 
  ON public.tracks FOR UPDATE 
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own tracks" 
  ON public.tracks FOR DELETE 
  USING (auth.uid() = user_id);

-- Metadata: Users can only access their own metadata
CREATE POLICY "Users can view own metadata" 
  ON public.user_metadata FOR SELECT 
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own metadata" 
  ON public.user_metadata FOR INSERT 
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own metadata" 
  ON public.user_metadata FOR UPDATE 
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own metadata" 
  ON public.user_metadata FOR DELETE 
  USING (auth.uid() = user_id);

-- Sync log: Users can only view their own logs
CREATE POLICY "Users can view own sync logs" 
  ON public.sync_log FOR SELECT 
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own sync logs" 
  ON public.sync_log FOR INSERT 
  WITH CHECK (auth.uid() = user_id);

-- ============================================
-- FUNCTIONS
-- ============================================

-- Function to create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'full_name',
    NEW.raw_user_meta_data->>'avatar_url'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to create profile on signup
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply updated_at trigger to tables
CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER update_tracks_updated_at
  BEFORE UPDATE ON public.tracks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER update_metadata_updated_at
  BEFORE UPDATE ON public.user_metadata
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Function to update track count in profile
CREATE OR REPLACE FUNCTION public.update_track_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.profiles 
    SET track_count = track_count + 1 
    WHERE id = NEW.user_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.profiles 
    SET track_count = track_count - 1 
    WHERE id = OLD.user_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER update_profile_track_count
  AFTER INSERT OR DELETE ON public.tracks
  FOR EACH ROW EXECUTE FUNCTION public.update_track_count();

-- ============================================
-- HELPFUL VIEWS
-- ============================================

-- View for getting user's active tracks (non-deleted)
CREATE OR REPLACE VIEW public.active_tracks AS
SELECT * FROM public.tracks 
WHERE is_deleted = FALSE;

COMMENT ON TABLE public.profiles IS 'User profiles extending Supabase auth, includes subscription status';
COMMENT ON TABLE public.tracks IS 'User talk tracks with full content and metadata';
COMMENT ON TABLE public.user_metadata IS 'Key-value store for customers, personas, categories, etc.';
COMMENT ON TABLE public.sync_log IS 'Audit log for sync operations';
