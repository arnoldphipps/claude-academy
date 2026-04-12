-- Run in Supabase SQL Editor
-- Adds badges column to profiles table

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS badges JSONB DEFAULT '[]'::jsonb;
