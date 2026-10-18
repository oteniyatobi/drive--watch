# Migrating DriverWatch from Firebase to Supabase

The code on this branch already uses Supabase for login, profiles and the recordings vault.
Video files stay in Cloudinary, and WhatsApp alerts stay on Twilio.
What's left is setting up the Supabase project and pasting in its keys.

## What changed

| Before (Firebase) | After (Supabase) |
|---|---|
| `firebase-config.js` | `supabase-config.js` (project URL + anon key) |
| Firestore `users/{uid}` | table `public.profiles` |
| Firestore `users/{uid}/recordings/{id}` | table `public.recordings` |
| `firestore.rules` | Row Level Security policies in `supabase/schema.sql` |
| Firestore `onSnapshot` (live vault) | Supabase Realtime on `recordings` |
| Firebase phone auth + reCAPTCHA | Supabase phone OTP (SMS through Twilio) |
| API checks Firebase ID token (`firebase-admin`) | API checks Supabase access token (`api/_lib/supabaseAdmin.js`) |

## Step 1: Create the project
1. Go to https://supabase.com/dashboard and create a new project. Pick the region closest to your drivers (for example, `eu-central-1` or `af-south-1` if available).
2. Save the database password somewhere safe.

## Step 2: Create the tables
1. Open **SQL Editor**, then **New query**.
2. Paste in all of `supabase/schema.sql` and click **Run**.
3. Check **Table Editor**. You should see `profiles` and `recordings`, each with RLS enabled.

## Step 3: Add the keys to the frontend
1. Open **Project Settings**, then **API**.
2. Copy the **Project URL** and the **anon public** key into `supabase-config.js`:
   ```js
   const SUPABASE_URL = 'https://abcd1234.supabase.co';
   const SUPABASE_ANON_KEY = 'eyJhbGciOi...';
   ```
   The anon key is safe to commit. RLS is what protects the data.

## Step 4: Set the auth URLs
Open **Authentication**, then **URL Configuration**:
- **Site URL**: `https://app.driverwatch.tech`
- **Redirect URLs**: add each of these:
  - `https://app.driverwatch.tech/login.html`
  - `https://app.driverwatch.tech/login`
  - `https://drive-watch-three.vercel.app/login.html` (keep it while the old link is still in use)
  - `http://localhost:3000/login.html`
  - `http://localhost:3000/login`

## Step 5: Turn on the sign-in methods
Open **Authentication**, then **Providers**.

**Email** (on by default)
- Decide whether to keep **Confirm email** on. If it's on, new users must click the emailed link before they can finish onboarding. The app shows them a "check your inbox" message.

**Google**
1. In Google Cloud Console, go to **APIs & Services**, then **Credentials**. You can reuse the OAuth client from the Firebase project.
2. Add this **Authorized redirect URI**: `https://<your-ref>.supabase.co/auth/v1/callback`
3. In Supabase, turn on Google and paste the **Client ID** and **Client secret**.
4. For the Android app, add the web client ID from `capacitor.config.json` (`157675587246-1f3t…apps.googleusercontent.com`) to the **Authorized Client IDs** field. Native sign-in uses `signInWithIdToken`, which only accepts tokens from listed client IDs.

**Phone**
1. Turn on Phone and pick **Twilio** as the SMS provider.
2. Enter your Twilio Account SID, Auth Token, and a Messaging Service SID or phone number. You already have a Twilio account for WhatsApp alerts.

## Step 6: Server environment variables
Add these to Vercel (**Project**, **Settings**, **Environment Variables**) and to your local `.env`:
```
SUPABASE_URL=https://<your-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role key from Project Settings → API>
```
- The **service_role** key bypasses RLS. Keep it server-side only. Never put it in `supabase-config.js`.
- You can delete `FIREBASE_SERVICE_ACCOUNT_JSON` from Vercel.

## Step 7: Test
1. Run `npx vercel dev` (or `npm start` for the frontend only).
2. Create an account, finish onboarding, and check that a row appears in `profiles`.
3. Start monitoring, trigger an incident clip, and check that a row appears in `recordings` and that it shows up in the Vault.
4. Delete the clip from the Vault and confirm it's removed from both Supabase and Cloudinary.
5. Deploy, then run `npm run cap:sync` to update the Android app.

## Step 8: Existing users
Firebase password hashes can't be imported into Supabase, so existing users need to sign up again. Google and phone users simply sign in again.
- **To bring old profiles and recordings across:** export the Firestore `users` collection from the Firebase console. Once each person has a new Supabase account, insert their profile and recordings rows with the new user id, using the same column names as in `schema.sql`.
- **If you have only a few test users:** it's simpler to let them sign up fresh.

## Step 9: Clean up after cutover
When everything works on Supabase, you can delete the Firebase leftovers:
- `firebase-config.js`, `firestore.rules`, `firestore.indexes.json`, `storage.rules`
- the Firebase project itself (after you've exported anything you want to keep)
