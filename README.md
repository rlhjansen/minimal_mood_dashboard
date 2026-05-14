# Minimal mood dashboard
Minimalistic journalling dashboard based on PANAS — works locally or hosted on GitHub Pages with optional multi-device cloud sync.

<img width="1726" height="819" alt="image" src="dashboard preview.PNG" />

## Purpose / Design

- The main interface is a randomized-order windrose. the purpose of the randomization is to keep the order in which you are prompted about each feeling/affect explicitly random to avoid getting into a "familiar pattern". text log is optional.
- The UI is purposefully kept minimal. you do not always feel good & then even minimal stimulus can be too much.
- "Gone to bed" & amount of hours slept are purposefully kept separate to force attention to both.
- The data is exportable in both database format & json; those two are enough structure to let chatGPT or your favourite LLM interface/copilot calculate whatever other metrics you want as you see fit. The positive/negative view over time is to feel like you are doing something, whatever something is, even if you are not doing great.
- The application is self-contained enough to just open in a browser, but also deployable as a static site via e.g. github pages with cloud sync via supabase like I do here https://rlhjansen.github.io/minimal_mood_dashboard/. If you use this I will not see your data, but the changes I make for personal use will be applied to your interface as well. I'll do my best to keep it minimal, but ultimately at this point the repo is in personal use & there is some personal stylization.
- the usage on phone is very awkward right now, but it does work; I have it as a link on my homescreen as a backup when I don't have access to my PC. The PANAS windrose drag functionality is currently especially atrocious - improving the interface for phone is on the planning.

## Quick start

**Local only** — open `index.html` in Chrome. Data is stored in the browser (localStorage).

**GitHub Pages + cloud sync** — deploy to Pages, then:

1. Create a free [Supabase](https://supabase.com) project.
2. Run the SQL below in the Supabase SQL Editor to create the sync table:
   ```sql
   CREATE TABLE user_data (
     id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id         uuid REFERENCES auth.users(id) NOT NULL UNIQUE,
     encrypted_blob  text NOT NULL,
     updated_at      timestamptz DEFAULT now()
   );
   ALTER TABLE user_data ENABLE ROW LEVEL SECURITY;
   CREATE POLICY "Users access own data"
     ON user_data FOR ALL
     USING (auth.uid() = user_id);
   ```
3. In Supabase → **Authentication → URL Configuration**, set:
   - **Site URL** → your Pages URL (e.g. `https://you.github.io/minimal_mood_dashboard/`)
   - **Redirect URLs** → same URL
4. On the dashboard, click **⚙️ Cloud Sync Settings**, paste your Supabase project URL and anon key, and save.
5. Enter your email and click **Send magic link**. Open the link in your inbox — you're synced.
6. On another device, repeat steps 4–5 with the same email. Data merges automatically.

Data is protected by Supabase Row Level Security — only the authenticated user can read/write their own row.

## Sleep Module

A **"Gone to bed"** button below the PANAS dashboard logs bedtime timestamps for passive tracking. The sleep section shows two charts:

| Chart | Details |
|---|---|
| **Sleep Trend** | Hours slept over time (from PANAS entries and standalone sleep logs) |
| **Bedtime Log** | Time-of-day dots showing when you pressed "Gone to bed" |

Both are independent — bedtime timestamps don't interact with hours-slept values.

## Files

```
index.html          – main dashboard (PANAS windrose + timeseries)
js/sync.js          – cloud sync module (Supabase auth + merge)
js/sleep.js         – sleep charts + bedtime logging
README.md
```


## Special Thanks

Inspired by a post from [forth](https://x.com/forthrighter/status/1957524801377169619).