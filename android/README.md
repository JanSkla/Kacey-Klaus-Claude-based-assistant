# Kacey for Android

A floating bubble that opens Kacey over any app, like a Messenger chat head,
and **Share → Kacey** for screenshots. Built for the owner's Nothing Phone (3a),
Android 15, and works on any Android 11+ phone.

The app is a thin shell. Kacey herself is the same page as on the desktop and
the kiosk, served by kaceybody, shown in a WebView. So there is nothing to
update here when Kacey changes; only the shell's own features live in this
folder.

| Piece | File | What it does |
|---|---|---|
| Bubble | `Bubble.kt` | Android's Bubbles API: a conversation shortcut plus a notification with BubbleMetadata. The system draws the bubble, lets you drag it, and dismisses it at the bottom. |
| The page | `WebHostActivity.kt` | WebView with the microphone (server Whisper STT, since a WebView has no SpeechRecognition), the paperclip's file picker, back, an offline page, and `window.KaceyNative`. It only ever loads Kacey's origin. |
| Bubble window | `BubbleActivity` in `Activities.kt` | The page inside the bubble. |
| Full screen | `KaceyActivity` | The page full screen. A share goes here if bubbles are off. |
| Share | `ShareActivity`, `ShareStore.kt` | Takes images and text from the share sheet, shrinks each image to 1568 px PNG, and opens the bubble. The page picks the share up with `KaceyNative.takeShare()` ([public/js/ui/share.js](../public/js/ui/share.js)), puts it in the composer, and waits for your optional note. |
| Tile | `BubbleTileService` | The "Kacey bublina" Quick Settings tile brings back a bubble you dismissed. |
| Boot | `BootReceiver` | Brings the bubble back after a reboot or an update, if it was on. |

## Requirements

- **Tailscale on the phone**, signed in to the same tailnet as kaceybody.
- **`tailscale serve --bg 8082` on kaceybody.** The WebView only grants the
  microphone on https, and this gives a real certificate. The app's default
  address is `https://kaceybody.tail87ce53.ts.net`; change it on the app's
  screen if yours differs.

## Build

The build uses Android Studio's bundled JDK and the SDK in `%LOCALAPPDATA%\Android\Sdk`.
`local.properties` (not committed) points at the SDK:

```
sdk.dir=C\:\\Users\\<you>\\AppData\\Local\\Android\\Sdk
```

```bash
cd android
JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew assembleDebug
```

The APK is written to `app/build/outputs/apk/debug/app-debug.apk`.

## Install

With the phone plugged in and USB debugging on (Settings → System → Developer options):

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Without a cable, copy the APK to the phone and open it. Android asks once to
allow installs from that app.

## First run

1. Open **Kacey** and tap **Povolit oznámení a mikrofon**.
2. Tap **Nastavení bublin v systému** and choose **Všechny konverzace mohou
   vytvářet bubliny** (All conversations can bubble). If you choose
   "Selected", switch on the Kacey conversation instead.
3. Tap **Zobrazit bublinu**. The Kacey square floats over everything; tap it to
   open Kacey, and tap it again or swipe back to fold it away.
4. Optional: add the **Kacey bublina** tile to Quick Settings.

**Nothing OS battery optimisation** can end the bubble's process in the
background. The bubble itself stays, and the page reloads when you open it.
If that gets annoying, set Kacey to "Unrestricted" in Settings → Apps → Kacey
→ Battery.

## Sending a screenshot

Take a screenshot, tap **Share**, pick **Kacey**. The bubble opens with the
image attached and the cursor in the message field. Write something like
"přidej do kalendáře s otazníkem", or just send it. With no text, Kacey
describes what she sees and offers to add it. An event she adds "with a
question mark" shows in the calendar with a dotted outline until you confirm
it.

Each window (the bubble, full screen, the desktop) has its own conversation
with Kacey, as each browser tab does. Memory and the calendar are shared.
