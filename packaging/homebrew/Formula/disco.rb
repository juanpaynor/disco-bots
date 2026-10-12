class Disco < Formula
  desc "Capture responses from ChatGPT, Gemini and Claude"
  homepage "https://github.com/juanpaynor/disco-bots"
  url "https://github.com/juanpaynor/disco-bots/releases/download/v0.1.0/aidisco-cli-0.1.0.tgz"
  sha256 "449e30de0c545458569e8301c79e2eb0279c6ea020f273d47242e6f9ec6bf0bc"
  version "0.1.0"

  depends_on macos: :sonoma
  depends_on "node"

  def install
    libexec.install Dir["*"]
    (bin/"disco").write <<~SH
      #!/bin/sh
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/bin/disco.mjs" "$@"
    SH
    (bin/"disco").chmod 0755
  end

  def caveats
    <<~EOS
      Run disco to start. The first launch downloads Chromium automatically
      and guides you through account login. Saved logins and results stay
      in ~/.aidisco across upgrades. Use disco --install-browser to prefetch.
    EOS
  end

  test do
    assert_match "AiDisco #{version}", shell_output("#{bin}/disco --version")
    assert_match "--login", shell_output("#{bin}/disco --help")
  end
end
