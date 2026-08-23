# Privacy Policy — vstack

_Last updated: 2026-08-23_

vstack is a local, single-user tool that runs entirely on your own computer. It
is not a hosted service. There is no vstack server, no account, and no operator
who can see what you do with it.

## What it collects

Nothing. vstack has no analytics, no telemetry, no crash reporting, and no
third-party services other than the ones you point it at yourself (YouTube, via
`yt-dlp` and the YouTube Data API).

## What it stores, and where

All of it stays on your machine:

- `media/` — cached video clips fetched from YouTube.
- `~/.vstack/youtube-client.json` — your own Google OAuth client credentials.
- `~/.vstack/youtube-token.json` — the OAuth tokens that authorise uploads.
- `localStorage` in your browser — the current editing session (URL, marks,
  crop boxes, theme).

None of it is transmitted anywhere except as described below.

## What it sends

If you use the YouTube publishing feature, vstack requests the single scope
`https://www.googleapis.com/auth/youtube.upload` and sends your rendered video
file and its title, description and privacy setting directly to Google's
YouTube Data API, to upload to your own channel. That is the only outbound
transmission of your data, and it goes only to Google.

vstack does not read your channel, your other videos, your subscribers, or any
other Google data — the upload scope does not permit it.

## Sharing

None. Your data is never sold, shared, or transferred to anyone.

## Removing your data

- Revoke vstack's access at <https://myaccount.google.com/permissions>.
- Delete `~/.vstack/` to remove the stored credentials and tokens.
- Delete `media/` to remove cached clips.

Uploaded videos live in your own YouTube account and are managed there.

## Contact

Open an issue at <https://github.com/vuongvu1/vstack/issues>.
