# Enclave guide

Everything about [Enclave](https://github.com/flo-wolf/obsidian-enclave) in detail: the two kinds
of password, locking notes and folders, commands, what is and isn't encrypted, how the encryption
works, the settings, and the interface for sync plugins.

**There is no password recovery.** If you forget a password, the notes locked with it can't be
opened anymore. Keep a backup of anything you can't afford to lose.

## Installation

Enclave needs Obsidian 1.13 or later.

**From the community plugins** (recommended)

1. In Obsidian, open **Settings → Community plugins** and select **Browse**.
2. Search for **Enclave**, then select **Install** and **Enable**.

Or open [Enclave in the Obsidian community directory](https://community.obsidian.md/plugins/enclave).

**With BRAT** (new versions before they reach the directory)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from the
   community plugins.
2. In BRAT, add the repository `flo-wolf/obsidian-enclave`.

**Manually**

1. Download `main.js`, `manifest.json` and `styles.css` from the
   [latest release](https://github.com/flo-wolf/obsidian-enclave/releases/latest).
2. Copy them into `<your-vault>/.obsidian/plugins/enclave/`.
3. Enable **Enclave** under **Settings → Community plugins**.

If your vault syncs through [Envoy](https://github.com/flo-wolf/obsidian-envoy), iCloud, or
Obsidian Sync with "Installed community plugins" turned on, the plugin reaches your other devices,
including iOS, with the vault.

## Usage

### Two kinds of password

- **Vault password**: one password for all your everyday locked notes, for
  convenience. You enter it once per session; it's kept in memory and forgotten
  after 30 minutes unused (configurable) or when Obsidian quits.
- **Separate password**: a password for one note, or one group of notes, as an
  extra barrier. It's meant for notes that shouldn't open just because you're
  already working in Obsidian, so by default you enter it every time.

**Remember passwords for the session** in the settings changes this: **Vault
password only** (default), **Vault and separate passwords**, or **Don't
remember**, which asks for every password every time. Remembered passwords are
never written to disk.

You choose the vault password the first time you lock a note with it. After
that, a mistyped vault password is rejected right away instead of locking notes
under a password you didn't mean. The same goes for a folder's separate
password. Enclave remembers a small encrypted check for each, never the password
itself (see [Password checks](#password-checks)).

### Lock and unlock a note

Right-click a note in the file explorer:

| Menu item | What it does |
|---|---|
| **Enclave: lock note** | Encrypts the note with the vault password. |
| **Enclave: lock with separate password** | Encrypts the note with a password of its own. |
| **Enclave: unlock note** | Decrypts the note so you can read and edit it. It locks again when you leave it. |
| **Enclave: permanently decrypt note** | Removes the encryption for good and turns it back into a normal note. |

The lock icon in the left ribbon turns orange while any note is unlocked; clicking
it then locks them all again, each with its own password. When nothing is
unlocked, it unlocks the current note if it's locked, or locks it with the vault
password if it isn't.

### Lock a folder

Right-click a folder → **Enclave: lock folder** (vault password) or **Enclave:
lock folder with separate password** (one password for the whole folder). This
locks every note in it, including subfolders, and keeps the folder locked:

- **A note moved into the folder** brings up a prompt to lock it too. For a
  vault-password folder you confirm; for a separate-password folder you enter
  that folder's password. Only the folder's own password is accepted, even if
  notes with other passwords sit in it.
  Moving several notes, or a whole folder, asks once.
- **A note created in the folder** is locked the first time you leave it.
- **Renaming or moving the folder** keeps it locked.
- **Notes you permanently decrypt** inside the folder stay decrypted.

Each note keeps its own password, so a folder can mix both kinds: lock one note
with a separate password, then lock the folder, and the folder lock leaves that
note alone.

**Unlocking a folder** (right-click → **Enclave: unlock all notes in folder**) is
temporary, like unlocking a note: the folder stays locked and its notes lock
again when you leave them. Enclave asks for the vault password if any notes use
it, then for a separate password if any notes use one. Every note that password
opens is unlocked; notes with a different password stay locked and are listed in
the summary. Cancel the separate-password prompt to skip them.

**Permanently decrypting a folder** (right-click → **Enclave: permanently decrypt
folder**) removes the encryption from its notes and stops keeping it locked.

### Lock several notes

Select several notes, right-click, and choose **lock selected notes** or **lock
selected notes with separate password** (one password for all of them). This
locks just those notes; unlike a folder, nothing is kept locked afterwards.

### Commands

All actions are also in the command palette:

| Command | |
|---|---|
| Lock note (vault password) | Current note |
| Lock note with a separate password | Current note |
| Unlock note | Current note |
| Permanently decrypt note (remove encryption) | Current note |
| Lock all currently-unlocked notes | Re-locks everything you have open right now |
| Lock every note in the vault (vault password) | Whole vault |
| Unlock every locked note in the vault | Whole vault |
| Permanently decrypt every locked note in the vault | Whole vault |
| Lock all notes and forget passwords | Locks every unlocked note, then clears every password from memory |
| Secure notes left exposed (after a crash) | Only shown when needed, see [below](#while-a-note-is-unlocked) |

While notes are unlocked, the status bar shows how many (for example
"1 unlocked"). Click it to lock them all. It disappears once everything is
locked.

## What is and isn't encrypted

| Encrypted | Not encrypted |
|---|---|
| The note's text | The note's file name |
| The note's own properties (frontmatter) | Folder names |
| | Attachments: images, PDFs and any other non-Markdown file |
| | Notes while they are unlocked (see below) |

Enclave only encrypts Markdown notes. Locking a folder does not touch the other
files in it.

## How it works

### A locked note on disk

Locking replaces the note's contents with this, in the same `.md` file:

````markdown
---
locked: true
lock-scope: vault
---
```enclave
{"v":1,"alg":"AES-GCM","kdf":"PBKDF2","hash":"SHA-256","iterations":310000,"salt":"…","iv":"…","ct":"…","scope":"vault"}
```
````

- `locked` marks the note as encrypted. `lock-scope` says which password it
  needs: `vault` or `note` (separate).
- `ct` holds the entire original note, properties included, encrypted.
- In Obsidian, the block shows as a card saying the note is locked, with an
  **Unlock** button. A locked note can't be typed into; unlock it to edit.
- Because it's still a plain text file, a locked note syncs, backs up and works
  with version control like any other note.

### Encryption

- A 256-bit AES-GCM key is derived from your password with PBKDF2 (SHA-256,
  310,000 iterations by default).
- Every note gets its own random salt and IV, so two notes with the same text
  and password still look completely different.
- AES-GCM is authenticated: a wrong password or a tampered file fails with an
  error instead of producing garbage.
- Before the plain text is overwritten, the encrypted result is decrypted and
  compared to the original. If they differ, the lock is cancelled and the note
  is left as it was.
- Everything uses the Web Crypto API built into Obsidian, on desktop and mobile.

### While a note is unlocked

Unlocking writes the plain text back to the file so you can edit it normally.
That means **an unlocked note is readable on disk and by your sync service**
until it is locked again. Enclave keeps that window short:

- It re-locks a note when you navigate away from it.
- It re-locks notes that have been idle for 5 minutes (configurable).
- It re-locks everything when Obsidian quits, and when it's hidden: on mobile
  whenever the app goes to the background, on desktop when you minimize it or
  switch to another space (you can turn that off in the settings).

If Obsidian crashes while notes are unlocked, Enclave notices on the next start
and offers **Secure notes left exposed** to encrypt them again.

### Password checks

To recognise a mistyped password, Enclave keeps a check for the vault password
and for each separate-password folder in its settings file
(`.obsidian/plugins/enclave/data.json`). A check is a short fixed text encrypted
with the password, exactly like a note, so it is just as hard to brute-force as
any locked note and reveals nothing more. The passwords themselves are never
stored.

If you already had vault notes before checks existed, the vault check is created
the first time the vault password successfully unlocks one of them.

### Changing the vault password

**Settings → Vault password → Change** lets you choose a new vault password the
next time you lock a note. Notes locked with the old one still open with the old
one: if the new password doesn't open a note, Enclave asks for the earlier
password. When that note locks again while you're using the new vault password,
it's re-encrypted with the new one, so old notes move over as you use them.

### Permanent decryption

Permanently decrypting a note restores it as a normal note and removes it from
Enclave's tracking. It will not be locked again unless you lock it yourself.

### Syncing with other plugins

While a note is unlocked, its plain text is on disk, so a sync tool could upload it.
[Envoy](https://github.com/flo-wolf/obsidian-envoy) uses the interface below so that never happens.
Enclave offers
sync plugins a small interface at `app.plugins.getPlugin("enclave").api` (see
[`src/api.ts`](../src/api.ts)) to prevent that:

- **`holdReason(path)`** says whether a note must not be uploaded right now: it's unlocked, a crash
  left it unlocked, or it's waiting to be locked in a locked folder.
- **`isIntentionallyPlain(path)`** says whether you made a note plain on purpose (permanently
  decrypted it, or chose not to lock it when you moved it into a locked folder).
- **`lockAll()`** and **`onLocked()`** let a sync plugin lock everything before syncing, or sync a
  note as soon as it's locked.
- **`openForMerge()`** lets a sync plugin merge conflicting versions of a locked note: Enclave
  decrypts them in memory only, asks for any password it doesn't have, and encrypts the result
  again. The sync plugin never sees a password.

When you lock a note without having changed it, Enclave writes back its exact earlier encrypted
version, so sync tools see no change and two devices can't conflict over it.

## Settings

Settings are stored in the vault and sync with it. Phones and tablets can have
their own values for remembering passwords and auto-locking (see **Use different
settings on phones and tablets**); both sets sync, so you can change the mobile
values from your desktop.

| Setting | Default | |
|---|---|---|
| Lock when leaving a note | On | Re-lock a note when you switch to another note. |
| Hide properties of locked notes | On | Hide the properties box on locked notes, which only shows Enclave's own `locked` and `lock-scope` properties. |
| Lock when Obsidian is hidden | On | Desktop only: re-lock unlocked notes when you minimize Obsidian or switch to another space or full-screen app. On mobile, notes always re-lock when the app goes to the background. |
| Auto-lock after inactivity | 5 min | Re-lock idle unlocked notes. `0` turns it off. |
| Remember passwords for the session | Vault password only | Which passwords stay in memory after you've entered them: the vault password only, the vault and separate passwords, or none. Never written to disk. |
| Forget passwords after | 30 min | How long remembered passwords stay in memory without being used. `0` keeps them until Obsidian quits. |
| Use different settings on phones and tablets | Off | Give phones and tablets their own **remember passwords**, **forget passwords after** and **auto-lock after inactivity** values; the regular ones then apply to desktop only. |
| Key derivation iterations | 310,000 | PBKDF2 iterations for newly locked notes. Higher is slower to unlock and slower to brute-force. |
| Verify before overwriting | On | The round-trip check described above. Roughly doubles the time a lock takes. |
| Vault password | Not chosen | Whether you've chosen a vault password. **Change** lets you choose a new one the next time you lock a note; see [Changing the vault password](#changing-the-vault-password). |
| Passwords in memory | | What's unlocked and which passwords are remembered on this device, and when that ends on its own. **Lock and forget** does it right away, like the **Lock all notes and forget passwords** command; you never need to click it for notes to lock. |
| Locked folders | None | Folders you've [locked](#lock-a-folder), with their kind of password. Deleting one from the list stops locking new notes there; its notes stay as they are. |

## Development

```bash
npm install      # install dependencies
npm run dev      # rebuild main.js on every change
npm run build    # type-check and build a production bundle
npm run deploy   # build and copy the plugin into $OBSIDIAN_VAULT
npm test         # run the test suite
```

To try a change before releasing it, run
`OBSIDIAN_VAULT=/path/to/vault npm run deploy`, then turn Enclave off and on
again under Settings → Community plugins (or run **Reload app without saving**).
This overwrites the copy BRAT installed; BRAT puts the released version back the
next time it updates.

To publish a release, set the version in `manifest.json`, `package.json` and
`versions.json`, then push a tag with exactly that version (for example
`1.0.1`, no `v`). A GitHub Action builds the plugin and attaches `main.js`,
`manifest.json` and `styles.css` to the release, which is what BRAT installs.
