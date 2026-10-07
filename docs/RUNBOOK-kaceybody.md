# kaceybody runbook

The system steps the night routine needs ([DREAM.md](DREAM.md)), for a person
to run by hand on kaceybody. Claude can update files on that machine but cannot
restart services or change system configuration. So everything here is yours,
and every step ends with a check that it worked.

Sections follow the phases. Run a section once, when its phase is deployed, and
tick it off in the table at the end.

> Paths and user names below assume the kiosk user is the one Kacey runs as
> (`kacey.service`). Replace `<user>` with it. Commands prefixed with `sudo`
> need it; the rest run as that user, **inside the graphical session** (a
> terminal on the laptop, or `ssh` with `export DISPLAY=:0` and the right
> `XAUTHORITY`).

---

## P1 — lightsd publishes `morning_peak_at`

```bash
cd ~/project-kacey-finds-home && git pull          # or however lightsd is deployed
sudo systemctl restart lightsd
curl -s http://127.0.0.1:8080/api/status | python3 -c 'import json,sys; s=json.load(sys.stdin); print(s["wake_at"], s["morning_peak_at"])'
```

**Check:** two times print, e.g. `06:30 07:00`. The second one is when the
morning brief will play. If it looks wrong for your schedule, the rule is in the
lightsd README ("The top of the sunrise"). Usually the fix is to put the sunrise
keypoints into one routine (`group: "morning"`).

---

## P2 — the screen, the GPU, the kiosk

### What kaceybody actually runs (found 2026-09-25)

Not a desktop. There is no display manager and no GNOME:

- **`kiosk.service`** (system unit) runs `/usr/local/bin/kiosk-session` on
  tty1. That's **cage 0.2.1**, a Wayland compositor that runs one fullscreen
  client, showing **Epiphany** (GNOME Web, WebKitGTK) at `KIOSK_URL`. The
  default is nowplayingd's record page on `:8081`. It's documented in the
  lights repo's `tools/kiosk/README.md`.
- **Audio** is plain ALSA (no PipeWire, no PulseAudio).
- **The lid** is already ignored by logind (`/etc/systemd/logind.conf.d/99-server.conf`).
- **The GPU** is an NVIDIA **GeForce 940MX** (Maxwell). The installed driver is
  NVIDIA's **610** from their CUDA repo, which dropped Maxwell. That's the
  console's "supported through the NVIDIA 580.xx Legacy drivers … No NVIDIA
  GPU found". That repo's apt list is also corrupted, so `apt` currently fails.
- **Kacey** binds `HOST=100.110.245.58` (Tailscale) and, since `ff1774c`, also
  127.0.0.1.

What that means:

- **The screen:** cage has no protocol for switching the panel off, so `xset`
  and DPMS do nothing. Kacey darkens the screen at the **backlight**
  (`/sys/class/backlight/intel_backlight/bl_power`), which needs write access
  (step 2). The compositor keeps running with the backlight off, so the page
  still sees the mouse and the keyboard. That's how a dark screen wakes up.
- **The voice:** there's no speech engine on the box. The plan is **XTTS on the
  940MX**, which first needs the right driver (step 1).
- **Listening:** WebKitGTK has no working speech recognition, so dictation
  moves to a server-side Whisper (a later step).

### 1. The NVIDIA 580 legacy driver (root, then reboot)

Only compute is needed. The Intel GPU keeps driving the screen, so install the
**headless** 580 packages from Ubuntu's own archive, not the NVIDIA repo that
broke apt.

```bash
# apt works again: drop the corrupted list and the CUDA repo (PyTorch brings its own CUDA runtime)
sudo rm -f /var/lib/apt/lists/developer.download.nvidia.com_compute_cuda_repos_ubuntu2604_x86%5f64_Packages
sudo mv /etc/apt/sources.list.d/cuda-ubuntu2604-x86_64.list /etc/apt/sources.list.d/cuda-ubuntu2604-x86_64.list.disabled
sudo mv /etc/apt/preferences.d/cuda-repository-pin-600 /etc/apt/preferences.d/cuda-repository-pin-600.disabled

# the 610 stack that ignores this GPU
sudo apt purge -y 'nvidia-*' 'libnvidia-*' cuda-drivers cuda-keyring
sudo apt autoremove -y

# Ubuntu's 580 branch, compute only (Maxwell needs the proprietary modules, not -open)
sudo apt update
sudo apt install -y nvidia-headless-580 nvidia-utils-580
```

Don't reboot yet: step 2 needs one too.

**Check (after the reboot):** `nvidia-smi` shows the GeForce 940MX and its
memory. Send Claude that output, since XTTS-v2 needs about 3 GB of VRAM. With
4 GB it fits; with 2 GB it may not.

### 2. Kacey may switch the backlight (root, then reboot)

```bash
sudo tee /etc/udev/rules.d/90-kacey-backlight.rules >/dev/null <<'EOF'
# Let the video group switch the panel's backlight - Kacey darkens the bedside screen (docs/DREAM.md §6).
ACTION=="add", SUBSYSTEM=="backlight", RUN+="/bin/chgrp video /sys%p/bl_power /sys%p/brightness", RUN+="/bin/chmod g+w /sys%p/bl_power /sys%p/brightness"
EOF
sudo usermod -aG video kaceybody
sudo reboot
```

**Check:** `ls -l /sys/class/backlight/intel_backlight/bl_power` shows group
`video` and `rw-rw-r--`. `id` lists `video`. After Kacey starts,
`journalctl -u kacey | grep "\[screen\] backend"` says `backlight`.

### 3. The kiosk shows Kacey (root)

```bash
sudo systemctl edit kiosk
```

Add:

```ini
[Service]
Environment=KIOSK_URL=http://127.0.0.1:8082/?kiosk=1
```

Then:

```bash
sudo systemctl restart kiosk
```

- `127.0.0.1` because the browser treats it as a secure origin, which is what
  lets the page use the microphone.
- `?kiosk=1` makes this page the one that plays the morning brief by itself.
- `kiosk-session` already waits for the URL to answer before starting the
  browser.

**Check:** the laptop shows Kacey. Within 2 minutes the screen goes dark
(`[screen] off (idle)` in `journalctl -u kacey`). Moving the mouse or pressing
a key lights it again.

**If Epiphany asks for the microphone or for sound** (a bar at the top of the
page): tap *Allow* once with the touchpad. It remembers it for this address.

To go back to the record: `sudo systemctl revert kiosk && sudo systemctl restart kiosk`.

### 4. XTTS on the GPU and Whisper on the CPU (done by Claude, no root, 2026-09-25)

Both run as **user** units, so they need no sudo. `Linger=yes` keeps them
running without a login.

| Unit | Venv | What |
| ---- | ---- | ---- |
| `xtts` (`voicelab/xtts.service`) | `~/.venvs/xtts`: Python 3.11 via uv, torch 2.6 cu126 (the last builds with `sm_50`), coqui-tts | XTTS-v2 in **float16** on the 940MX: ~950 MiB after load, ~1.1 GB peak. About **2× slower than real time** (a 5 s sentence in ~11 s) |
| `stt` (`voicelab/stt.service`) | `~/.venvs/stt`: Python 3.11, faster-whisper | Whisper `small`, int8, on the CPU: about real time once warm |

```bash
systemctl --user status xtts stt
journalctl --user -u xtts -u stt -f
nvidia-smi
```

Because XTTS is slower than real time here, **the night run renders the
morning brief to audio** (`data/brief-audio/<date>/`, one WAV per line), and the
morning plays finished files. Live answers during the day still synthesise
sentence by sentence, with pauses between sentences.

The 1.8 GB model loads on the CPU before moving to the GPU, which pushes about
1.7 GB into swap on this 7 GB machine. So the first Whisper request after a
quiet spell can take tens of seconds while its pages come back.

ollama's embedding model (`nomic-embed-text-v2-moe`, ~0.6 GB) still fits on the
GPU next to XTTS (1.2 GB total seen). If it ever doesn't, ollama falls back to
the CPU by itself.

**Pending, root:** Epiphany runs incognito, which forgets the wake-word samples
and the microphone permission on every restart. Install the launcher with
`KIOSK_INCOGNITO` (lights repo `d5c6dc1`):

```bash
sudo install -m 755 ~/kacey/tools/kiosk/kiosk-session.sh /usr/local/bin/kiosk-session && printf '[Service]\nEnvironment=KIOSK_URL=http://127.0.0.1:8082/?kiosk=1\nEnvironment=KIOSK_INCOGNITO=0\n' | sudo tee /etc/systemd/system/kiosk.service.d/override.conf && sudo systemctl daemon-reload && sudo systemctl restart kiosk
```

### 5. Does the page keep listening in the dark?

Run this once the wake word runs in the kiosk:

1. Let the screen go dark.
2. Wait 5 minutes, then say "KC".
3. `journalctl -u kacey --since '-10 min' | grep -E 'page visibility|\[screen\]'`.

With the backlight backend the page should never go hidden, because the
compositor doesn't know the panel is off. If a `page visibility: hidden` line
shows up anyway, tell Claude.

### 6. The screen as the PC's second monitor (Windows, then root)

The Controller's **Druhý monitor** switch ([monitor.js](../monitor.js)) starts
Moonlight over the kiosk. On the PC, Apollo adds a virtual display for as long
as the stream runs. cage puts Moonlight on top of Epiphany, and when Moonlight
exits the Kacey page is underneath again. To end it, use the switch, press
Ctrl+Alt+Shift+Q on the laptop, or disconnect the client in Apollo on the PC.

**On the PC (Windows):**

1. Install **Apollo** (github.com/ClassicOldSong/Apollo, releases). It brings
   its own virtual display driver (SudoVDA). Open `https://localhost:47990` and
   set a login.
2. Keep the real monitors on: the virtual display should *extend* the desktop.
   If your monitors go dark during a stream, set Apollo's display device
   configuration (Configuration → Audio/Video) to leave the other displays
   alone. Arrange the new display in Windows' Display settings once (Windows
   remembers it per virtual display).
3. Note the PC's Tailscale name (`tailscale status`). Kacey's host reaches it
   over the tailnet.

**On kaceybody (root):**

Moonlight isn't in Ubuntu 26.04's apt (checked 2026-10-06). The snap is
the packaged one, and it brings its own VA-API drivers for the HD 620:

```bash
sudo snap install moonlight
printf 'KACEY_MONITOR_HOST=<pc tailscale name>\nKACEY_MONITOR_CMD=/snap/bin/moonlight\n' | sudo tee -a /etc/kacey.env
sudo systemctl restart kacey
```

Checked on the real kiosk (2026-10-06): cage 0.2.1 runs a second client over
Epiphany full screen, survives it closing, and Epiphany comes back still in
full screen. The cage 0.2 assertion in `kiosk-session` is about Epiphany
restoring several tabs at start, not about a second program.

**Pair once:** pairing prints a PIN that you type into Apollo on the PC (Apollo
web UI → PIN). Claude can run it over ssh, inside the kiosk's session (no root):

```bash
XDG_RUNTIME_DIR=/run/user/$(id -u) WAYLAND_DISPLAY=wayland-0 QT_QPA_PLATFORM=wayland /snap/bin/moonlight pair <pc tailscale name>
```

The PIN shows on the bedside screen (light it first: move the mouse).
Paired 2026-10-06 with PIN entry in Apollo. Apollo lists three apps for this
client: `Desktop`, `Steam Big Picture` and `Virtual Display`. Kacey opens
**Virtual Display**, the one that adds a display. `Desktop` would only show
the PC's existing screens.

**The snap launcher needs `~/.config/user-dirs.dirs` (done by Claude,
2026-10-06, no root).** Without that file the snap's `desktop-launch`
rebuilds its MIME cache on every start. On this disk that took 1–4 minutes,
so a switch press seemed to do nothing. The file points every XDG folder at
`$HOME`, so no new folders appear. With it, the launcher starts in about 1 s.

**What a start costs:** about 10 s while Apollo creates the virtual display,
then the picture. When Kacey ends the stream it also runs `moonlight quit`, so
the PC closes the session and removes the display. If a session is still open
on the PC (Moonlight killed some other way), the next start first spends ~30 s
quitting it.

**Two things Kacey sets for Moonlight** (monitor.js, nothing to configure):
`SDL_VIDEO_WAYLAND_ALLOW_LIBDECOR=0`, because SDL otherwise loads libdecor's
GTK plugin for the window frame. That plugin aborts inside the snap (no icon
theme), so the stream window is never shown: the stream runs, the decoder
backs up ("Video decode unit queue overflow"), and the screen keeps showing
Kacey. And `PKGSYSTEM_ENABLE_FSYNC=0`, so the MIME rebuild after a snap
update takes seconds.

**Check:** in the Controller, *Druhý monitor* says `vypnuto` with
`Moonlight ← <pc> · Virtual Display` under it. Switch it on. About 10 s
later the bedside screen shows the PC, and Windows lists a second display. Switch it off (or
Ctrl+Alt+Shift+Q) and Kacey is back. `journalctl -u kacey | grep '\[monitor\]'`
logs each start and end. If Moonlight dies at once, the line carries its
last output and the Controller shows it as *Naposledy: …*.

If the row says *Kiosk neběží nebo k němu Kacey nemá přístup*, cage runs as a
different user than Kacey or under another socket name. Find it with
`ls -l /run/user/*/wayland-*` and set `KACEY_RUNTIME_DIR` /
`KACEY_WAYLAND_DISPLAY` in `/etc/kacey.env`.

---

## P3 and later — deploying a Kacey change

Claude updates the files; you restart:

```bash
sudo systemctl restart kacey
journalctl -u kacey -n 30
```

The kiosk page reconnects on its own. After a change to anything under
`public/`, reload it by restarting the kiosk: `sudo systemctl restart kiosk`.

**P3 check:** press "Jdu spát" in lightsd. `journalctl -u kacey -f` shows
`awake -> winding_down` and `[screen] off (winding_down)`. Tap the screen, and
it shows `-> awake (interaction)`.

---

## Done

| Section | Done on | Notes |
| ------- | ------- | ----- |
| P1 lightsd (deployed by Claude) | 2026-09-25 | wake_at 06:30, morning_peak_at 07:00 |
| P2.1 NVIDIA 580 driver | 2026-09-25 | 940MX, 2 GB |
| P2.2 backlight udev rule + reboot | 2026-09-25 | backend: backlight |
| P2.3 kiosk shows Kacey | 2026-09-25 | incognito still on: see P2.4 |
| P2.4 XTTS on the GPU, Whisper (Claude) | 2026-09-25 | float16, ~2× slower than real time; brief pre-rendered at night |
| P2.5 listening in the dark |  |  |
| P2.6 second monitor (Apollo, Moonlight, pairing) |  |  |
