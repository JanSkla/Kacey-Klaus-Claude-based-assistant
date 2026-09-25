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
