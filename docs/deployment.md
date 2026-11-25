# Digital Heroes deployment and schema

## Dedicated assignment deployment

1. Sign in to the new assignment Vercel account and the dedicated Supabase project. Create a Stripe test webhook and use a verified sender if delivery is part of the review.
2. Apply all migrations in `supabase/migrations/` in numeric order on the new Supabase project. They create the private `printshop` schema and the `press-private` bucket. Keep `printshop` out of the exposed Data API schemas. Use Supabase Auth to create and confirm the reviewer staff user. Run `npm run seed:hosted` with `APP_MODE=hosted`, a connection URL and `SEED_STAFF_EMAIL`. This seeds the six products and assigns the confirmed reviewer to the staff role. Create the reviewer customer in Supabase Auth or through the public signup flow. [Supabase migrations](https://supabase.com/docs/guides/local-development/database-migrations)
3. Deploy this source to Vercel as a Next.js project and set the production variables from `.env.example` through the Vercel dashboard. Set `APP_MODE=hosted` and `APP_ORIGIN` to the final HTTPS origin. Use the Supabase **transaction pooler** URL for the web process and the **session pooler** or direct connection for the worker and migrations. Prefer verified TLS in each connection URL. Set the site's origin and allow the confirmation callback path with query parameters in Supabase Auth. The callback accepts a PKCE code or a confirmation token hash. [Vercel environments](https://vercel.com/docs/deployments/environments) · [Supabase connection modes](https://supabase.com/docs/guides/database/connecting-to-postgres) · [Supabase redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)
4. Register `/api/print/stripe/webhook` at the deployed origin for `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Set the webhook signing secret and a Stripe test secret key. Use the test card documented by Stripe. Confirm the payment event in Stripe and check the job state in the staff console. [Stripe test cards](https://docs.stripe.com/testing) · [Stripe checkout fulfillment](https://docs.stripe.com/checkout/fulfillment.md?ui=full-page)
5. Run a persistent Node worker with `npm run worker` or build and run `Dockerfile.worker`. Provide the hosted database, Supabase Storage, app origin, and optional email environment variables to that service. It processes the database queue and notification outbox. The web app stays available on Vercel while worker capacity scales independently. Production file downloads redirect to short-lived, private storage URLs after the role and order checks. Large jobs have numbered archives.
6. Repeat both reference orders from a clean session. Verify the public URL, signup and staff access, real Stripe test confirmation, Supabase Storage, and email arrival in the test inbox. Record order IDs, proof versions and files. Share reviewer credentials through a private channel.

Set `RESEND_API_KEY` and `EMAIL_FROM` to enable email delivery. The outbox records each recipient and provider acceptance and retries transient errors with the notification ID as the provider idempotency key. Local mode records demo notifications. Use the provider dashboard and test inbox for final delivery evidence. [Resend idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys)

## Schema

| Tables | Responsibility |
| --- | --- |
| `accounts`, `demo_credentials`, `demo_sessions` | Supabase identity projection and app role. The last two tables are used by loopback mode. |
| `catalogue` | One active record per division. Each definition holds size ranges, base price, VAT, materials, template revision and print profile. |
| `orders` | Owner, public order number, current configuration, quote snapshot, latest draft, stage and proof pointers. The order revision provides an optimistic concurrency check. |
| `assets` | Private staging key and normalized image key, hash, pixel size and order ownership. |
| `proofs`, `approvals` | Append-only proof snapshots, sequential versions, canonical SHA-256, named approvals and references to inherited approvals. Published layout, fonts and dataset are pinned by renderer version and frozen asset files. |
| `checkout_attempts`, `payment_event_log`, `payments` | Binding across the order, proof, price and gateway session. Unique provider event and payment reference keys deduplicate delivery. Orders with mismatched or obsolete payments enter review. |
| `jobs`, `manifest` | One job per approved paid version, processing lease, progress, build attempts and complete immutable file set. Asset keys are isolated by lease. The manifest is published transactionally. |
| `order_events`, `notifications` | Actor, proof, event details and timestamp, plus delivery attempts for each recipient. Completed orders remain accessible through the archive filter. |

## Application checks

- The Node API authenticates each protected request and checks the account against the order owner. Staff mutation and production file access require the staff role from the database. The Supabase Data API has no direct access to the application schema or private bucket.
- Stripe confirmation locks the order before checking the approved version and checkout binding. Event, payment and job writes commit together. A browser return page reads the authoritative state.
- The renderer outlines text with the vendored, OFL-licensed fonts, validates rotated bounds in millimetres, and emits the same canonical artwork for proof and production. PDF media and bleed boxes include bleed. The trim box describes the finished product. Raster mode is intentional for the demo.
- Reserve Vercel for web and shorter conversion requests. Source artwork travels directly to the private bucket in hosted mode. Staging and superseded worker attempts can be removed under an operator-defined retention policy after checking active and approved references.
- Reports use UTC date filters and the effective dates for order creation, payment and completion. The accounting export contains invoice ID, customer reference, line, quantity, net, discount, VAT, gross, currency and payment reference.
