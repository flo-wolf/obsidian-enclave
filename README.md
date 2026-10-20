# Enclave

**Lock your private notes with a password. Encrypted on disk, readable only in Obsidian.**

A diary, health notes, client work, anything you'd rather keep to yourself: lock it with Enclave
and it's encrypted with AES-256, the same standard banks and password managers use. Your sync
service, your backups, your cloud folder and every other app only ever see scrambled text. In
Obsidian, you unlock a note with your password, edit it as usual, and Enclave locks it again when
you're done.

## Why Enclave

- **Lock with one click.** Right-click a note or a folder and choose **Lock**.
- **Locks itself again.** When you leave the note, after a few idle minutes, and when you close or
  hide Obsidian. On your phone, as soon as you switch apps.
- **Lock whole folders.** Everything inside is locked, and new notes you write there are locked
  too.
- **One password, or several.** Use one vault password for everyday private notes, and a separate
  password for the few that need more protection.
- **Still part of your vault.** Locked notes keep their names, so links, search by title and the
  graph keep working.
- **On every device.** Desktop and mobile, with nothing else to install.
- **Careful by design.** Every lock is checked before your note is replaced, and a mistyped
  password is rejected instead of locking your notes with a typo.

**There is no password recovery.** Enclave never stores your passwords. If you forget one, the
notes locked with it can't be opened anymore, by you or anyone else. Keep a backup of anything you
can't afford to lose.

## Sync safely with Envoy

[Envoy](https://github.com/flo-wolf/obsidian-envoy) syncs your vault across iPhone, Android, Mac,
Windows and Linux through your own private GitLab project, for free. Used together, your locked
notes only ever leave your device encrypted:

- Envoy never uploads a note while it's unlocked. It waits until Enclave locks it again.
- The sync button can lock every open note first, so everything goes up in one go.
- When a locked note changed on two devices, you can still merge the changes. Enclave decrypts both
  versions in memory only and locks the result again.

Enclave works with any other sync too, such as iCloud or Obsidian Sync. Just keep in mind that while
a note is unlocked, its text sits on disk unencrypted, and those services may upload it in that
moment.

## Get started

1. **Install Enclave.** In Obsidian, open **Settings → Community plugins → Browse**, search for
   **Enclave**, then select **Install** and **Enable**.
2. **Lock a note.** Right-click it in the file explorer and choose **Enclave: lock note**. The first
   time, you choose your vault password.
3. **Open it again.** Select **Unlock** on the note and enter your password. When you leave the
   note, it locks itself.

To protect a whole folder, right-click it and choose **Enclave: lock folder**. While notes are
unlocked, the status bar shows how many, and the lock icon in the left sidebar locks them all at
once.

## What's encrypted

| Encrypted | Not encrypted |
|---|---|
| The note's text | The note's name |
| The note's properties | Folder names |
| | Images, PDFs and other attachments |

## Learn more

The [Enclave guide](https://github.com/flo-wolf/obsidian-enclave/blob/main/docs/guide.md) covers
everything in detail: both kinds of password, locking folders and several notes at once, all
commands and settings, how the encryption works, and what happens while a note is unlocked.

## Credits and license

Enclave is a fork of [Locky](https://github.com/boinkdevteam/obsidian-locky) by boinkdevteam, which
is itself a fork of [Lockbox](https://github.com/danzar/Obsidian-Locker) by Danzar. Licensed under
the GNU General Public License v3.0 or later, like both projects it is based on; see
[`LICENSE`](https://github.com/flo-wolf/obsidian-enclave/blob/main/LICENSE).
