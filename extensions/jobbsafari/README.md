# Jobbsafari Job Filter (AI)

Chrome extension (Manifest V3) for [jobbsafari.se](https://jobbsafari.se/lediga-jobb) job lists. It reads every ad on the
current list page, asks an AI model how well it fits **your** resume and rules, and hides the ones that don't fit.
Built from consultant-job-filter 1.0.0 (same settings, AI providers and panel). Part of
[job-filter-hub](https://github.com/majid-sharif-soleimani/job-filter-hub), and also works as a standalone extension.

## Install
1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. The first click on the icon opens the options page.
3. Choose an AI provider, paste your API key and your resume (plain text), write your hard criteria
   (see the guide at the top of `settings.js`), then press **Save & test API**.

## Use
Open a job list (`jobbsafari.se/lediga-jobb`, or a filtered one such as `/lediga-jobb/ort/stockholm`) and click the icon.
Each ad page is fetched in the background (no tab is opened), scored, and the card gets a badge. Rejected ads are hidden
(or faded) and remembered. "Auto next page" in the panel goes on to `?page=N+1` until you press Stop.

## Privacy
API keys, resume and settings are stored only in your browser (`chrome.storage.local`) and are sent only to the AI provider
you choose. Ad pages are read from jobbsafari.se itself.

---

## راهنمای فارسی
- یک لیست آگهی در jobbsafari.se باز کنید (مثلاً `jobbsafari.se/lediga-jobb/ort/stockholm`) و روی آیکون کلیک کنید.
- اکستنشن صفحهٔ هر آگهی را در پس‌زمینه می‌خواند، به AI می‌دهد و نمره را روی کارت نشان می‌دهد. آگهی‌های رد شده پنهان (یا کم‌رنگ) و به خاطر سپرده می‌شوند.
- تیک «Auto next page» در پنل، بعد از تمام شدن هر صفحه به صفحهٔ بعد می‌رود.
