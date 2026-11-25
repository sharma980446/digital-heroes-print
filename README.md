# Digital Heroes Print

A six-division web-to-print application for the Digital Heroes Level 2 assignment. The reference journeys are a three-runner race order and 100 identical matte stickers. The same order system handles quotes, proof revisions, payment, production and repeat orders.

## Run locally

Use Node.js 22.13 or later and npm.

```powershell
npm ci
npm run dev
```

Open `http://127.0.0.1:3000`. Local mode creates a PostgreSQL database under `.data/postgres` and keeps uploads and generated files under `.data/private`. The Next.js process runs the local worker. Use a customer account you register in the app. In a separate browser profile, sign in as `staff@print.example` with `PressRoom-Local-42!`. These credentials are for the loopback demo.

1. Open **Race & event numbers**. Keep the quantity at three and create an order. Upload [the sample CSV](public/samples/runners.csv) and publish v1. Check bib `007` and select the other two rows.
2. Request changes. Open the same order from the staff queue, revise the event title and publish v2. Approve v2 as the customer, then confirm the simulated test payment.
3. Open the staff order. Download one PDF, one PNG and the batch ZIP. Start production and mark it completed. Retrieve the job in **Archive**. Reorder its approved work from the customer account.
4. Open **Labels & stickers** and choose 50 × 50 mm, Matte vinyl, 100 units. Confirm ₹108.00 including demo tax. Add a PNG logo or upload finished artwork, then approve and pay. Measure the single PDF/PNG pair. The PDF trim is 50 × 50 mm with a 56 × 56 mm bleed box. The 300 ppi PNG is 661 × 661 px.

New orders use Indian rupees. Catalogue settings use paise, so a base price of 100 means ₹1.00. If you open an unpaid quote from before the currency change, choose **Review INR quote** or **Update quote to INR** before checkout.

For finished artwork, export one artboard at the order's dimensions including bleed. The SVG converter supports outlined paths and basic shapes. For AI uploads, enable **Create PDF Compatible File** when saving. Use a PNG above the required pixel count. The demo fonts support Latin and Latin Extended glyphs.

## Verification

```powershell
npm run typecheck
npm test
npm run build
npm run test:browser
```

Run browser acceptance with the local server up. It uses Microsoft Edge through Playwright by default. It checks a 360 px customer flow, a 1440 px staff flow, quote retention through signup, browser payment cancellation and retry, order isolation, the archive, reorder, and the two file sets. It writes screenshots and measurable output files to `test-results/browser/`. Use `DH_CHROMIUM_CHANNEL=chrome` with Chrome installed if preferred.

## Assignment handover

- [Implementation plan and design decisions](docs/implementation-plan.md)
- [Database schema and hosted deployment](docs/deployment.md)
- [Runner CSV](public/samples/runners.csv)

The storefront gallery shows six proof samples rendered by this application. Replace or supplement them with approved operator photos for a gallery of the shop's physical work. Print output uses RGB demo profiles. Obtain the shop's colour, device and material specifications for physical production, especially laser cutting and engraving.
