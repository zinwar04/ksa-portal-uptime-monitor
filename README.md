# KSA Portal external uptime monitor

This public repository contains only a read-only monitoring script for the public KSA Portal URL. It does not contain portal application code, database records, user data, or credentials.

GitHub Actions secrets hold the authenticated synthetic-account and Supabase metrics credentials. The workflow can be run manually to check the Vercel page, Supabase Auth, a deliberately low-permission portal member, database/storage/connection metrics, and Supabase API errors.

GitHub-hosted runners are free for public repositories. This account's runner requests currently fail before GitHub allocates a runner or starts a step, so the schedule is paused rather than creating repeated empty failures. The repository remains a source-free external monitor when that account-level issue is resolved.
