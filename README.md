# Enclave

Encrypt a note's **contents** while keeping its **title visible**. Locked notes
stay as ordinary `.md` files — they show up in the file explorer, graph, and
links by name — but their body is sealed with authenticated encryption until you
unlock or permanently decrypt them.

Enclave is a fork of [Locky](https://github.com/boinkdevteam/obsidian-locky) by
boinkdevteam, which is itself a fork of
[Lockbox](https://github.com/danzar/Obsidian-Locker) by Danzar. Both are licensed
under the GPL-3.0, as is Enclave.

## Features

- 🔒 **Lock / unlock individual notes** via commands, the ribbon icon, or the
  file context menu.
- 🔓 **Permanent Decryption (Undo Initial Encryption)**:
  - **Permanently decrypt a note** — completely removes encryption, writes plain markdown back to disk, and removes the note from auto-lock registry.
  - **Permanently decrypt a group of notes** — right-click a folder or multi-select notes in File Explorer to permanently decrypt them in a batch.
  - **Permanently decrypt the vault** — undoes encryption for all vault-password notes across the entire vault with a single command.
- 🗝️ **Two key models:**
  - **Vault password** — one password (cached in memory for the session)
    unlocks every note locked with the vault default.
  - **Per-note password** — lock a sensitive note with its own password.
- 🧮 **Strong crypto** — PBKDF2 (SHA-256, 310k iterations by default) derives an
  AES-GCM-256 key. Each note gets a fresh random salt and IV, and GCM
  authentication means a wrong password fails cleanly instead of returning
  garbage.
- ⏱️ **Auto-lock** — re-encrypt a note when you navigate away, after an
  inactivity timeout, and on Obsidian quit. The cached vault password expires
  after a configurable interval.
- ✅ **Encryption self-check** — before a note's plaintext is overwritten, the
  freshly-made ciphertext is decrypted and compared to the original. If it
  doesn't match, the lock is aborted and the note is left untouched, so a faulty
  lock can never silently destroy content.
- 🟡 **Status-bar indicator** — shows how many notes are currently unlocked
  (i.e. have plaintext on disk). Click it to lock everything at once.
- 💪 **Password-strength hint** — a meter on the lock dialog nudges you away
  from trivial passwords.
- 📄 **Plain `.md` storage** — the encrypted payload lives in a fenced
  ` ```enclave ` block, so locked notes still sync, back up, and version like
  any other note. Notes locked by Locky or Lockbox are still recognized and can
  be unlocked; they switch to Enclave's format the next time they're locked.

## Installation

Enclave is not listed in the Obsidian community directory.

### BRAT
Add this repository in the [BRAT](https://github.com/TfTHacker/obsidian42-brat)
plugin. For a private repository, give BRAT a fine-grained GitHub token with
read-only **Contents** access to this repository only.

### Manual install
Run `npm run build`, then copy `main.js`, `manifest.json`, and `styles.css` to
`<your-vault>/.obsidian/plugins/enclave/` and enable **Enclave** under
Settings → Community plugins. If your vault syncs (iCloud or Obsidian Sync with
community plugins enabled), the plugin reaches your other devices the same way.

## How a locked note looks on disk

````markdown
---
locked: true
lock-scope: vault
---

> [!lock]- 🔒 Encrypted with Enclave
> This note is locked. Run **Enclave: Unlock note** (or click the ribbon lock
> icon) to decrypt it.

```enclave
{"v":1,"alg":"AES-GCM","kdf":"PBKDF2","hash":"SHA-256","iterations":310000,"salt":"…","iv":"…","ct":"…","scope":"vault"}
```
````

The note's *own* frontmatter and body are encrypted together inside `ct`, so
nothing of the original content leaks — only the filename stays readable.

## ⚠️ Security model — read this

This plugin gives you **encryption at rest while a note is locked.** Be aware of
the tradeoffs of in-place editing:

- **While a note is unlocked, its plaintext is written to disk** so you can edit
  it as a normal note. Auto-lock-on-close (on by default), the inactivity timer
  (5 min default), and a best-effort lock on quit shrink this window. If the app
  crashes or is force-quit while a note is unlocked, plaintext can remain on
  disk — on the next launch Enclave detects this from a recovery ledger and
  prompts you to run **Enclave: Secure notes left exposed**.
- **Permanent decryption undoes encryption permanently**: when a note is permanently decrypted, it is restored as regular plain markdown on disk and will never be re-locked automatically.
- **There is no password recovery.** Forget a password and the note is
  unrecoverable. Keep backups of anything important.
- The vault password is held in memory only and never persisted. It is cleared
  on quit and after the "forget" timeout.

## Usage

| Action | How |
|--------|-----|
| Lock the active note with the vault password | Command **Enclave: Lock note (vault password)** or the ribbon lock icon |
| Lock with a separate password | Command **Enclave: Lock note with a separate password**, or file menu → **Enclave: lock with separate password** |
| Unlock the active note (temporary) | Command **Enclave: Unlock note**, ribbon icon, or file menu |
| **Permanently decrypt active note** | Command **Enclave: Permanently decrypt note (remove encryption)** or file menu |
| Re-encrypt all unlocked notes now | Command **Enclave: Lock all currently-unlocked notes** |
| Lock / unlock / permanently decrypt a folder | Right-click a folder → **Enclave: lock / unlock / permanently decrypt all notes in folder** |
| Lock a folder or selection with one shared separate password | Right-click → **Enclave: lock all notes in folder with separate password** / **lock selected notes with separate password** |
| Lock / unlock / permanently decrypt selected notes | Multi-select notes in File Explorer → Right-click → **Enclave: lock / unlock / permanently decrypt selected notes** |
| **Permanently decrypt entire vault** | Command **Enclave: Permanently decrypt every locked note in the vault** |
| Lock / unlock the entire vault | Commands **Enclave: Lock every note in the vault** / **Unlock every locked note in the vault** |
| Clear the cached vault password | Command **Enclave: Forget vault password (lock session)** |
| Re-secure notes left exposed by a crash | Command **Enclave: Secure notes left exposed** (only available when needed) |

Bulk unlock and permanent decryption ask for the vault password if any vault
notes are involved, then for one separate password if any separate-password notes
are involved. That password is tried on each of them: notes locked together as a
group open, and notes with a different password are reported and stay locked.
Cancel the separate-password prompt to skip those notes.

## Settings

- **Auto-lock on close** — re-encrypt an unlocked note when you navigate away (default on).
- **Auto-lock after inactivity** — minutes before an idle unlocked note re-locks (`0` = off).
- **Forget vault password after** — minutes the vault password stays cached (`0` = until quit).
- **Key derivation iterations** — PBKDF2 iterations for newly locked notes.
- **Verify before overwriting** — round-trip-check each lock before replacing the note (default on; roughly doubles lock time).

## Development

```bash
npm install      # install deps
npm run dev      # watch build -> main.js
npm run build    # type-check + production bundle
npm test         # run unit test suite
```

## License

GNU General Public License v3.0 (GPL-3.0-or-later) © 2025-2026. See [`LICENSE`](LICENSE).
