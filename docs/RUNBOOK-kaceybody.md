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

## P2 — kiosk, screen, lid

### 1. What is there now

Run these and **send the output back** before changing anything. The rest of
this section assumes an X11 session, and this is where that gets confirmed.

```bash
loginctl list-sessions
loginctl show-session $(loginctl list-sessions --no-legend | awk '$3=="<user>"{print $1; exit}') -p Type -p Desktop -p Service -p Name -p State
echo "session type: $XDG_SESSION_TYPE"
ps -eo user,pid,cmd | grep -Ei 'chrom|firefox' | grep -v grep
ls -l ~/.Xauthority /run/user/$(id -u)/gdm/Xauthority 2>&1
cat /etc/gdm3/custom.conf 2>/dev/null | grep -Ev '^\s*(#|$)'
which xset xprintidle chromium chromium-browser google-chrome 2>&1
snap list 2>/dev/null | grep -i chrom
ls /proc/acpi/button/lid/ && cat /proc/acpi/button/lid/*/state
systemctl cat kacey | grep -E 'User|Environment'
```

### 2. X11, not Wayland

`xset dpms` does nothing under Wayland, and Ubuntu's GDM defaults to Wayland.

```bash
sudo sed -i 's/^#\?\s*WaylandEnable=.*/WaylandEnable=false/' /etc/gdm3/custom.conf
grep -q '^WaylandEnable=false' /etc/gdm3/custom.conf || echo 'WaylandEnable=false' | sudo tee -a /etc/gdm3/custom.conf
```

**Check (after the reboot in step 8):** `echo $XDG_SESSION_TYPE` → `x11`.

### 3. Autologin

In `/etc/gdm3/custom.conf`, under `[daemon]`:

```ini
AutomaticLoginEnable=true
AutomaticLogin=<user>
```

**Check (after the reboot):** the laptop boots straight into the desktop with
no password prompt.

### 4. The desktop must not blank, lock or suspend on its own

`screen.js` decides when the panel sleeps. Two owners would fight.

```bash
gsettings set org.gnome.desktop.session idle-delay 0
gsettings set org.gnome.desktop.screensaver lock-enabled false
gsettings set org.gnome.desktop.screensaver idle-activation-enabled false
gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing'
gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-battery-type 'nothing'
gsettings set org.gnome.settings-daemon.plugins.power idle-dim false
sudo apt install -y xprintidle x11-xserver-utils
```

**Check:** `xprintidle` prints a number of milliseconds; `xset q | grep -A2 DPMS` works.

### 5. The kiosk

A script that the session starts at login. It hands DPMS to Kacey (on, but with
no timeouts of its own) and opens Chromium full-screen on Kacey.

`~/bin/kacey-kiosk.sh`:

```bash
#!/bin/sh
# Kacey's bedside kiosk. Started by ~/.config/autostart/kacey-kiosk.desktop.
xset s off            # no X screensaver
xset +dpms            # DPMS on, so `xset dpms force on|off` works...
xset dpms 0 0 0       # ...but with no timers: Kacey's screen.js is the only owner
# Wait for Kacey to answer before opening the page.
until curl -sf http://localhost:8082/api/health >/dev/null; do sleep 2; done
exec chromium \
  --kiosk --noerrdialogs --disable-infobars \
  --autoplay-policy=no-user-gesture-required \
  --check-for-update-interval=31536000 \
  http://localhost:8082
```

Use `chromium-browser` or `google-chrome` if that's what step 1 found.

```bash
chmod +x ~/bin/kacey-kiosk.sh
mkdir -p ~/.config/autostart
cat > ~/.config/autostart/kacey-kiosk.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=Kacey kiosk
Exec=/home/<user>/bin/kacey-kiosk.sh
X-GNOME-Autostart-enabled=true
EOF
```

**Why the autoplay flag:** the morning brief is spoken with nobody touching the
screen. Without the flag Chromium blocks the audio until the first tap.

### 6. The microphone without a prompt

The wake word needs the microphone with nobody there to click "Allow". Grant it
to this one origin with a managed policy. That is narrower than
`--use-fake-ui-for-media-stream`, which accepts every prompt from every site.

```bash
# deb Chromium / Chrome:
sudo mkdir -p /etc/chromium/policies/managed /etc/opt/chrome/policies/managed
# snap Chromium reads this one instead:
sudo mkdir -p /etc/chromium-browser/policies/managed
for d in /etc/chromium/policies/managed /etc/chromium-browser/policies/managed /etc/opt/chrome/policies/managed; do
  echo '{ "AudioCaptureAllowedUrls": ["http://localhost:8082"], "AutoplayAllowed": true }' | sudo tee $d/kacey.json >/dev/null
done
```

**Check:** in the kiosk, `chrome://policy` lists `AudioCaptureAllowedUrls`.
Saying "KC" works after a reboot without any prompt.

### 7. A closed lid must not suspend the laptop

```bash
sudo mkdir -p /etc/systemd/logind.conf.d
sudo tee /etc/systemd/logind.conf.d/kacey-lid.conf >/dev/null <<'EOF'
[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
EOF
```

Apply it by **rebooting** (step 8), not with `systemctl restart systemd-logind`.
That can end the graphical session, which on a kiosk means a black screen until
someone logs in.

**Check (after the reboot):** close the lid for a minute and open it. Kacey is
still reachable (`curl http://kaceybody:8082/api/health` from another machine
works while the lid is shut), and `cat /proc/acpi/button/lid/*/state` says
`closed` while shut.

### 8. Tell Kacey where the display is, then reboot

A systemd service inherits neither `DISPLAY` nor `XAUTHORITY`. Put them in
Kacey's environment file (`/etc/kacey.env`, or wherever `systemctl cat kacey`
points). Use the Xauthority path step 1 found:

```bash
echo 'KACEY_DISPLAY=:0' | sudo tee -a /etc/kacey.env
echo 'KACEY_XAUTHORITY=/run/user/1000/gdm/Xauthority' | sudo tee -a /etc/kacey.env   # or /home/<user>/.Xauthority
sudo reboot
```

**Check, after the reboot:**

```bash
journalctl -u kacey -n 50 | grep -E '\[screen\]|\[night\]'
curl -s http://127.0.0.1:8082/api/night | python3 -m json.tool | head -30
```

Within about 2 minutes of nobody touching it, the log shows
`[screen] off (idle)` and the panel goes dark. Moving the mouse wakes it (the
OS does that), and 2 minutes later it goes dark again. `"lid": "open"` is in
`/api/night`.

### 9. Does the page stay "visible" with the panel off?

This decides whether the wake word works at night. It must be measured on the
real machine, not assumed:

1. Let the panel go dark (or run `xset dpms force off` in the session).
2. Wait 5 minutes, then say "KC".
3. `journalctl -u kacey --since '-10 min' | grep 'page visibility'`

- **No `page visibility: hidden` line, and "KC" lit the screen:** done. Write
  "visible with DPMS off" into [DREAM.md §6](DREAM.md#the-screen-dpms).
- **A `hidden` line, or "KC" did nothing:** add these flags to the Chromium line
  in `kacey-kiosk.sh`, reboot, and repeat:
  `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`
  If it is still hidden, tell Claude. The fallback is a change to the wake
  predicate in code (DREAM.md §6).
4. Repeat the test **with the lid closed**. Some setups switch the internal
   output off on lid close, which can hide the window.

---

## P3 and later — deploying a Kacey change

Claude updates the files; you restart:

```bash
sudo systemctl restart kacey
journalctl -u kacey -n 30
```

The kiosk page then reconnects on its own. After a change to anything under
`public/`, reload the page as well (a tap-and-hold is not available in kiosk
mode, so restart the kiosk: `pkill chromium`, and the autostart script brings
it back on the next login, or run `~/bin/kacey-kiosk.sh &` in the session).

**P3 check:** press "Jdu spát" in lightsd. `journalctl -u kacey -f` shows
`awake -> winding_down` and `[screen] off (winding_down)`. Tap the screen, and
it shows `-> awake (interaction)`.

---

## Done

| Section | Done on | Notes |
| ------- | ------- | ----- |
| P1 lightsd restart |  |  |
| P2.1 current state sent back |  |  |
| P2.2–8 kiosk, DPMS, lid, env, reboot |  |  |
| P2.9 visibility with DPMS off |  |  |
