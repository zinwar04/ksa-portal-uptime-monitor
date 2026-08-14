# KSA Portal external uptime monitor

This public repository contains only a read-only monitoring script for the public KSA Portal URL. It does not contain portal application code, database records, user data, or credentials.

GitHub Actions secrets hold the authenticated synthetic-account and Supabase metrics credentials. The workflow runs every 15 minutes and checks the Vercel page, Supabase Auth, a deliberately low-permission portal member, database/storage/connection metrics, and Supabase API errors.

GitHub-hosted runners are free for public repositories. Keep this repository public so its scheduled monitor remains free.
