# Platsbanken Job Filter (AI)

Chrome extension (Manifest V3) for **Arbetsförmedlingen Platsbanken** (`arbetsformedlingen.se/platsbanken/annonser?...`).
It goes through the ads on a search results page (both the **Platsbanken** and the **Externa webbplatser** tab), opens each one in the background (Platsbanken has no preview pane),
asks an AI model how well the ad fits **your** resume and rules, and marks the result on the page.
Sister project of [linkedin-job-filter](https://github.com/majid-sharif-soleimani/linkedin-job-filter).

## Install
1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Pin the icon. The first click opens the options page (or right-click the icon → Options).
3. Choose an AI provider, paste your API key and your resume (plain text), write your hard criteria
   (see the example and guide at the top of `settings.js`), then press **Save & test API**.

## Privacy
Your API keys, resume and settings are stored only in your browser (`chrome.storage.local`). They are sent only to the AI
provider you choose and are never part of this repository. Do not commit exported settings or resume files (see `.gitignore`).

Technical details: `ARCHITECTURE.md` · history: `CHANGELOG.md`.

---

## راهنمای فارسی

## نصب
1. `chrome://extensions` → Developer mode را روشن کنید → **Load unpacked** → پوشه `platsbanken-job-filter` را انتخاب کنید.
2. آیکون را در نوار اکستنشن‌ها pin کنید.
3. اولین کلیک صفحه تنظیمات را باز می‌کند (یا راست‌کلیک روی آیکون → Options):
   سرویس AI، مدل، API Key، رزومه (متن) و معیارها را وارد کنید و **Save & test API** را بزنید.

## استفاده
- در صفحه نتایج جستجوی Platsbanken (مثلاً `arbetsformedlingen.se/platsbanken/annonser?q=Dotnet&l=...`) روی آیکون کلیک کنید.
- چون سایت پیش‌نمایش ندارد، هر آگهی در یک **iframe مخفی** داخل همان صفحه (یا اگر در تنظیمات انتخاب کنید، در یک **تب پس‌زمینه** که بعد بسته می‌شود) باز و خوانده می‌شود و متنش به AI داده می‌شود.
- آگهی‌های مناسب نشان سبز می‌گیرند و (اگر روشن باشد) با دکمه قلب سایت **Spara annons** ذخیره می‌شوند.
- آگهی‌های نامناسب نشان قرمز می‌گیرند و کم‌رنگ یا کاملاً مخفی می‌شوند (Platsbanken دکمه ✕ ندارد).
- تیک **Auto next page** در پنل باعث می‌شود بعد از هر صفحه خودش دکمه **Nästa** را بزند و تا صفحه آخر یا Stop ادامه دهد.
- بعد از آخرین صفحه Platsbanken، خودش به تب **Externa webbplatser** می‌رود و آگهی‌های سایت‌های دیگر را هم بررسی می‌کند (قابل خاموش کردن در تنظیمات). اگر فقط آگهی‌های خارجی را می‌خواهید، همان تب را باز کنید و روی آیکون کلیک کنید.
- چون Platsbanken از آگهی‌های خارجی فقط خلاصه‌ای حدود ۳۰۰ حرفی نشان می‌دهد، اکستنشن متن کامل آگهی را از سایت مبدأ (مثل ledigajobb.se) می‌خواند. برای این کار کروم یک بار اجازه «خواندن سایت‌های دیگر» می‌خواهد (با Save در تنظیمات). بدون این اجازه فقط همان خلاصه به AI داده می‌شود و در گزارش پنل نوشته می‌شود.
- در پنل با **Details** گزارش هر آگهی را می‌بینید؛ روی عنوان هر مورد کلیک کنید تا آگهی در تب جدید باز شود.
- نمره هر آگهی ذخیره می‌شود تا دوباره هزینه API نشود، و دفعه بعد که صفحه نتایج را باز کنید نشان‌ها خودکار ظاهر می‌شوند؛ با Save در تنظیمات این حافظه پاک می‌شود.
- گزینه Dry run فقط نمره می‌دهد و چیزی را مخفی یا ذخیره نمی‌کند.

## نکات
- اگر ساختار سایت عوض شد، selectorها در بخش «DOM helpers» در `content.js` و در `extract.js` هستند. اگر کارتی پیدا نشود، پنل یک Diagnostic نشان می‌دهد.
- اگر خواندن صفحه آگهی شکست بخورد، متن آگهی از همان API که خود سایت استفاده می‌کند خوانده می‌شود.
