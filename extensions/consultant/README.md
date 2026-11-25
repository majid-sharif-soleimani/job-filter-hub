# Consultant.dev Job Filter (AI)

Chrome extension (Manifest V3) for [consultant.dev](https://consultant.dev) search pages. It reads every assignment on the
current results page, asks an AI model how well it fits **your** resume and rules, and hides the ones that don't fit.
Sibling of [linkedin-job-filter](https://github.com/majid-sharif-soleimani/linkedin-job-filter).

## Install
1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Pin the icon. The first click opens the options page (or right-click the icon → Options).
3. Choose an AI provider, paste your API key and your resume (plain text), write your hard criteria
   (see the guide at the top of `settings.js`), then press **Save & test API**.

## Privacy
API keys, resume and settings are stored only in your browser (`chrome.storage.local`) and are sent only to the AI provider
you choose. Assignment pages are read from consultant.dev itself. Do not commit exported settings or resume files.

Technical details: `ARCHITECTURE.md` · history: `CHANGELOG.md`.

---

## راهنمای فارسی

### نصب
1. `chrome://extensions` → Developer mode را روشن کنید → **Load unpacked** → پوشه `consultant-job-filter` را انتخاب کنید.
2. آیکون را pin کنید. اولین کلیک صفحه تنظیمات را باز می‌کند.
3. سرویس AI، مدل، API Key، رزومه و معیارها را وارد کنید و **Save & test API** را بزنید.

### استفاده
- یک جستجو در consultant.dev باز کنید (مثلاً `consultant.dev/search?q=Software+Engineer&tab=all`) و روی آیکون کلیک کنید.
- اکستنشن صفحه هر آگهی را در پس‌زمینه می‌خواند (تب جدید باز نمی‌کند، چون صفحه آگهی‌ها server-rendered است)، متن را به AI می‌دهد و نمره را روی کارت نشان می‌دهد.
- چون این سایت دکمه «علاقه ندارم» ندارد، آگهی‌های رد شده **روی خود صفحه پنهان** و در حافظه اکستنشن ذخیره می‌شوند تا در بازدیدهای بعدی هم پنهان بمانند. با برداشتن تیک **Hide rejected** در پنل، کم‌رنگ دیده می‌شوند.
- کلمات کلیدی رد خودکار و فهرست شهرهای قابل رفت‌وآمد بدون هزینه AI اعمال می‌شوند. این سایت آگهی‌های همه دنیا را دارد، پس فهرست شهرها بیشتر آگهی‌ها را رایگان حذف می‌کند.
- تیک **Auto next page** صفحه‌های بعدی را هم یکی‌یکی بررسی می‌کند تا Stop بزنید.
- گزینه Save matching فقط وقتی کار می‌کند که در consultant.dev وارد حساب شده باشید (دکمه قلب ♡).
- دکمه **Forget rejected assignments** در تنظیمات، فهرست آگهی‌های پنهان‌شده و نمره‌ها را پاک می‌کند.
- Dry run فقط نمره می‌دهد و چیزی را پنهان یا ذخیره نمی‌کند.

### نکات
- اگر سایت ساختار HTML را عوض کرد، selectorها در بالای `content.js` هستند (`CARD`, `cardLocation`, `fetchDetail`, `findNextButton`). کلیک روی آیکون در صفحه‌ای که کارتی پیدا نشود یک گزارش تشخیصی در پنل نشان می‌دهد.
