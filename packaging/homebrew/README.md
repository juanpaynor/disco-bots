# AiDisco Homebrew tap

Copy this directory into `juanpaynor/homebrew-disco` after building and publishing
the matching release. The package builder generates `Formula/disco.rb` with the
release URL and archive checksum.

Users can then run:

```sh
brew install juanpaynor/disco/disco
disco
```

Homebrew installs Node. JavaScript dependencies ship inside the release archive.
Chromium downloads automatically on the user's first launch, outside Homebrew's
installation directory. Logins and results remain in `~/.aidisco` on upgrades.
