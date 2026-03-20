# Worksheet Generator

Browser-based worksheet builder with drag and drop editing, random variable generation, printing, PDF export, and optional managed persistence.

## Features

- Drag, move, and resize shapes, text boxes, number boxes, and uploaded images on an A4 worksheet surface.
- Randomize text, numbers, colors, and asset choices when generating worksheet variants.
- Insert hardcoded pattern modules that generate grouped sequences like alternating A/B and repeating A/B/C strips.
- Print from the browser or export the current worksheet to a PDF file.
- Save named worksheets and uploaded assets to Supabase with per-account isolation.
- Reduce storage usage by resizing raster uploads client-side and deduplicating assets by content hash before upload.

## Run

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Supabase Persistence Setup

The app can run without a backend, but durable worksheet and asset storage is enabled only when Supabase environment variables are present.

1. Create a Supabase project.
2. Run the SQL in `supabase/schema.sql` in the Supabase SQL editor.
3. Copy `.env.example` to `.env`.
4. Fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
5. Restart the Vite dev server.

After that, create an account inside the app with a username and password. There is no email authentication, email verification, or Supabase Auth dependency in this flow.

Environment variables:

- `VITE_SUPABASE_URL`: Supabase project URL.
- `VITE_SUPABASE_ANON_KEY`: Supabase anon public key.
- `VITE_SUPABASE_ASSET_BUCKET`: Optional storage bucket name. Defaults to `worksheet-assets`.

## Storage Notes

- Each account can only see and mutate its own assets and worksheets through row-level security.
- Remote assets are deduplicated per account by content hash, so duplicate uploads do not create duplicate files for the same user.
- Raster uploads are resized to a max dimension of 1600px before upload when that reduces file size.
- Account sessions are managed by SQL functions and a client-stored session token sent in a custom request header.
- Asset files live in a private storage bucket and are loaded with signed URLs instead of public links.
- Worksheets store layout JSON and reference asset URLs instead of embedding base64 image data in worksheet records.
- Local browser draft persistence still exists for the current unsaved canvas, but it is not the durable storage path.
