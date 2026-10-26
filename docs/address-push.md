# Address push — phone → dash in one tap

Share a place from Google Maps on the iPhone; the dash's NAVIGATE tab receives
it over [ntfy.sh](https://ntfy.sh) and starts driving to it immediately.

## How it works

    iPhone Google Maps → Share → Shortcut "Push Address"
        → POST https://ntfy.sh/<your-topic>   (message = the shared text)
        → dash subscribes https://ntfy.sh/<your-topic>/sse (EventSource)
        → parses coordinates out of the Maps link (or geocodes the address
          text) → routes (Valhalla) → drive phase starts.

The topic name is the only secret — there is no auth, so pick something long
and unguessable (anyone who guesses it can send destinations to your dash).

## One-time setup

1. Dash: open NAVIGATE → right-edge push button (bottom rail) → type your
   topic → SAVE. The dot turns green when the subscription opens. The topic is
   kept in localStorage on that machine only — never in git.
2. iPhone: Shortcuts app → new shortcut named **Push Address**:
   - Settings sheet: enable **Use as Share Sheet** (input types: Text, URLs).
   - Google Maps shares only the bare `maps.app.goo.gl` short link — no place
     text. iOS resolves those links itself via **Get Dictionary from Input**
     (it returns `Name`, `Lat`, `Lng`, `Address`), so compose an exact-coords
     message the dash parses without any geocoding:
   - Action 1 — **Get Dictionary from Input** (input: **Shared Text**).
   - Action 2 — **If**: `Name (Get Dictionary from Input)` **has a value**.
   - Action 3 (inside If) — **Text**:
     `«Name (Get Dictionary from Input)» https://maps.google.com/?q=«Lat (Get Dictionary from Input)»,«Lng (Get Dictionary from Input)»`
   - Action 4 — **Otherwise** — **Text**: **Shared Text** (keeps non-Maps
     shares working via the geocode path).
   - Action 5 — **End If**.
   - Action 6 — **Get Contents of URL**:
     - URL: `https://ntfy.sh/<your-topic>`
     - Method: **POST**
     - HTTP Body: **Form input fields**, one field: Name `message`,
       Value: the **Text** result from the If branch.
   That's it. ntfy.sh also accepts a raw body, but the form field avoids
   Shortcuts' body-type quirks.

## Day to day

In Google Maps: place → Share → **Push Address**. The dash jumps to NAVIGATE
and starts navigating within a couple of seconds.

Works with three message shapes:

- long Maps links with the place pin embedded (`…!3d<lat>!4d<lng>`) — exact,
- `?q=lat,lng` / `@lat,lng` links,
- anything else — the address text is geocoded (Nominatim), biased to where
  the car currently is.

Test the pipe without the phone (desktop curl):

```bash
curl -d "https://maps.google.com/?q=37.44,-122.14" https://ntfy.sh/<your-topic>
```

The dash should jump to NAVIGATE and start driving toward Palo Alto.

## Limits

- `maps.app.goo.gl` short links are not followed by the browser (CORS) — the
  Shortcuts recipe above sidesteps that by letting iOS resolve the link and
  sending exact coordinates instead. Pushing a bare short link some other way
  (e.g. curl) says `PUSH UNPARSED · SEND A MAPS LINK OR ADDRESS`.
- Only messages published after the subscription opened are acted on
  (`?since=` + timestamp filter) — a stale link in the topic can't hijack a
  page reload.
- The topic is a shared secret over a public relay: convenient, but anyone who
  guesses it can push destinations. Treat NAVIGATE-on-push like a doorbell,
  not a command channel you'd trust with money.
