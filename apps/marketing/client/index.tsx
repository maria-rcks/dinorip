import { useEffect, useState } from "preact/hooks";

const REPO = "maria-rcks/dinorip";
const RELEASES_LATEST = `https://github.com/${REPO}/releases/latest`;

const HERO_SHOT =
  "https://raw.githubusercontent.com/maria-rcks/dinorip/main/apps/marketing/assets/app-shot.png";

type OS = "mac" | "windows" | "linux" | "other";

function detectOS(): OS {
  if (typeof navigator === "undefined") return "other";
  const data = (navigator as { userAgentData?: { platform?: string } }).userAgentData;
  const haystack = `${data?.platform ?? ""} ${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`.toLowerCase();
  if (/mac|iphone|ipad|ipod/.test(haystack)) return "mac";
  if (/win/.test(haystack)) return "windows";
  if (/linux|x11/.test(haystack) && !/android/.test(haystack)) return "linux";
  return "other";
}

function downloadLabel(os: OS): string {
  if (os === "mac") return "Download for macOS";
  if (os === "windows") return "Download for Windows";
  if (os === "linux") return "Download for Linux";
  return "Download";
}

// Filename extension of the installer that matches a given OS.
function assetExt(os: OS): string | null {
  if (os === "mac") return ".dmg";
  if (os === "windows") return ".exe";
  if (os === "linux") return ".appimage";
  return null;
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

// Pick the best installer asset for the detected OS from a GitHub release.
function pickAsset(os: OS, assets: ReleaseAsset[]): string | null {
  const ext = assetExt(os);
  if (!ext) return null;
  let matches = assets.filter((a) => a.name.toLowerCase().endsWith(ext));
  if (os === "mac" && matches.length > 1) {
    const arm = matches.find((a) => /arm64|aarch64/i.test(a.name));
    if (arm) matches = [arm];
  }
  return matches[0]?.browser_download_url ?? null;
}

const LOGO =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA4IDgiIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiBzaGFwZS1yZW5kZXJpbmc9Imdlb21ldHJpY1ByZWNpc2lvbiI+PHBhdGggZD0iTSAwIDAgTCAxIDAgTCAxIDEgTCAwIDEgTCAwIDAgWiIgZmlsbD0iIzJFMkEyNiI+PC9wYXRoPjxwYXRoIGQ9Ik0gMSAwIEwgMiAwIEwgMiAxIEwgMSAxIEwgMSAwIFoiIGZpbGw9IiMyRTJBMjYiPjwvcGF0aD48cGF0aCBkPSJNIDIgMCBMIDMgMCBMIDMgMSBMIDIgMSBMIDIgMCBaIiBmaWxsPSIjMkUyQTI2Ij48L3BhdGg+PHBhdGggZD0iTSAzIDAgTCA0IDAgTCA0IDEgTCAzIDEgTCAzIDAgWiIgZmlsbD0iIzJFMkEyNiI+PC9wYXRoPjxwYXRoIGQ9Ik0gNCAwIEwgNSAwIEwgNSAxIEwgNCAxIEwgNCAwIFoiIGZpbGw9IiMyRTJBMjYiPjwvcGF0aD48cGF0aCBkPSJNIDUgMCBMIDYgMCBMIDYgMSBMIDUgMSBMIDUgMCBaIiBmaWxsPSIjMkUyQTI2Ij48L3BhdGg+PHBhdGggZD0iTSA2IDAgTCA3IDAgTCA3IDEgTCA2IDEgTCA2IDAgWiIgZmlsbD0iIzJFMkEyNiI+PC9wYXRoPjxwYXRoIGQ9Ik0gNyAwIEwgOCAwIEwgOCAxIEwgNyAxIEwgNyAwIFoiIGZpbGw9IiMyRTJBMjYiPjwvcGF0aD48cGF0aCBkPSJNIDAgMSBMIDEgMSBMIDEgMiBMIDAgMiBMIDAgMSBaIiBmaWxsPSIjMkUyQTI2Ij48L3BhdGg+PHBhdGggZD0iTSAxIDEgTCAyIDEgTCAyIDIgTCAxIDIgTCAxIDEgWiIgZmlsbD0iIzdBOEM1QSI+PC9wYXRoPjxwYXRoIGQ9Ik0gMiAxIEwgMyAxIEwgMyAyIEwgMiAyIEwgMiAxIFoiIGZpbGw9IiM3QThDNUEiPjwvcGF0aD48cGF0aCBkPSJNIDMgMSBMIDQgMSBMIDQgMiBMIDMgMiBMIDMgMSBaIiBmaWxsPSIjN0E4QzVBIj48L3BhdGg+PHBhdGggZD0iTSA0IDEgTCA1IDEgTCA1IDIgTCA0IDIgTCA0IDEgWiIgZmlsbD0iIzdBOEM1QSI+PC9wYXRoPjxwYXRoIGQ9Ik0gNSAxIEwgNiAxIEwgNiAyIEwgNSAyIEwgNSAxIFoiIGZpbGw9IiM3QThDNUEiPjwvcGF0aD48cGF0aCBkPSJNIDYgMSBMIDcgMSBMIDcgMiBMIDYgMiBMIDYgMSBaIiBmaWxsPSIjN0E4QzVBIj48L3BhdGg+PHBhdGggZD0iTSA3IDEgTCA4IDEgTCA4IDIgTCA3IDIgTCA3IDEgWiIgZmlsbD0iIzJFMkEyNiI+PC9wYXRoPjxwYXRoIGQ9Ik0gMCAyIEwgMSAyIEwgMSAzIEwgMCAzIEwgMCAyIFoiIGZpbGw9IiMyRTJBMjYiPjwvcGF0aD48cGF0aCBkPSJNIDEgMiBMIDIgMiBMIDIgMyBMIDEgMyBMIDEgMiBaIiBmaWxsPSIjN0E4QzVBIj48L3BhdGg+PHBhdGggZD0iTSAyIDIgTCAzIDIgTCAzIDMgTCAyIDMgTCAyIDIgWiIgZmlsbD0iIzJFMkEyNiI+PC9wYXRoPjxwYXRoIGQ9Ik0gMyAyIEwgNCAyIEwgNCAzIEwgMyAzIEwgMyAyIFoiIGZpbGw9IiM3QThDNUEiPjwvcGF0aD48cGF0aCBkPSJNIDQgMiBMIDUgMiBMIDUgMyBMIDQgMyBMIDQgMiBaIiBmaWxsPSIjN0E4QzVBIj48L3BhdGg+PHBhdGggZD0iTSA1IDIgTCA2IDIgTCA2IDMgTCA1IDMgTCA1IDIgWiIgZmlsbD0iIzdBOEM1QSI+PC9wYXRoPjxwYXRoIGQ9Ik0gNiAyIEwgNyAyIEwgNyAzIEwgNiAzIEwgNiAyIFoiIGZpbGw9IiM3QThDNUEiPjwvcGF0aD48cGF0aCBkPSJNIDcgMiBMIDggMiBMIDggMyBMIDcgMyBMIDcgMiBaIiBmaWxsPSIjMkUyQTI2Ij48L3BhdGg+PHBhdGggZD0iTSAwIDMgTCAxIDMgTCAxIDQgTCAwIDQgTCAwIDMgWiIgZmlsbD0iIzJFMkEyNiI+PC9wYXRoPjxwYXRoIGQ9Ik0gMSAzIEwgMiAzIEwgMiA0IEwgMSA0IEwgMSAzIFoiIGZpbGw9IiM3QThDNUEiPjwvcGF0aD48cGF0aCBkPSJNIDIgMyBMIDMgMyBMIDMgNCBMIDIgNCBMIDIgMyBaIiBmaWxsPSIjMkUyQTI2Ij48L3BhdGg+PHBhdGggZD0iTSAzIDMgTCA0IDMgTCA0IDQgTCAzIDQgTCAzIDMgWiIgZmlsbD0iIzdBOEM1QSI+PC9wYXRoPjxwYXRoIGQ9Ik0gNCAzIEwgNSAzIEwgNSA0IEwgNCA0IEwgNCAzIFoiIGZpbGw9IiM3QThDNUEiPjwvcGF0aD48cGF0aCBkPSJNIDUgMyBMIDYgMyBMIDYgNCBMIDUgNCBMIDUgMyBaIiBmaWxsPSIjN0E4QzVBIj48L3BhdGg+PHBhdGggZD0iTSA2IDMgTCA3IDMgTCA3IDQgTCA2IDQgTCA2IDMgWiIgZmlsbD0iIzdBOEM1QSI+PC9wYXRoPjxwYXRoIGQ9Ik0gNyAzIEwgOCAzIEwgOCA0IEwgNyA0IEwgNyAzIFoiIGZpbGw9IiMyRTJBMjYiPjwvcGF0aD48cGF0aCBkPSJNIDAgNCBMIDEgNCBMIDEgNSBMIDAgNSBMIDAgNCBaIiBmaWxsPSIjMkUyQTI2Ij48L3BhdGg+PHBhdGggZD0iTSAxIDQgTCAyIDQgTCAyIDUgTCAxIDUgTCAxIDQgWiIgZmlsbD0iIzdBOEM1QSI+PC9wYXRoPjxwYXRoIGQ9Ik0gMiA0IEwgMyA0IEwgMyA1IEwgMiA1IEwgMiA0IFoiIGZpbGw9IiM3QThDNUEiPjwvcGF0aD48cGF0aCBkPSJNIDMgNCBMIDQgNCBMIDQgNSBMIDMgNSBMIDMgNCBaIiBmaWxsPSIjN0E4QzVBIj48L3BhdGg+PHBhdGggZD0iTSA0IDQgTCA1IDQgTCA1IDUgTCA0IDUgTCA0IDQgWiIgZmlsbD0iIzdBOEM1QSI+PC9wYXRoPjxwYXRoIGQ9Ik0gNSA0IEwgNiA0IEwgNiA1IEwgNSA1IEwgNSA0IFoiIGZpbGw9IiM3QThDNUEiPjwvcGF0aD48cGF0aCBkPSJNIDYgNCBMIDcgNCBMIDcgNSBMIDYgNSBMIDYgNCBaIiBmaWxsPSIjN0E4QzVBIj48L3BhdGg+PHBhdGggZD0iTSA3IDQgTCA4IDQgTCA4IDUgTCA3IDUgTCA3IDQgWiIgZmlsbD0iIzJFMkEyNiI+PC9wYXRoPjxwYXRoIGQ9Ik0gMCA1IEwgMSA1IEwgMSA2IEwgMCA2IEwgMCA1IFoiIGZpbGw9IiMyRTJBMjYiPjwvcGF0aD48cGF0aCBkPSJNIDEgNSBMIDIgNSBMIDIgNiBMIDEgNiBMIDEgNSBaIiBmaWxsPSIjN0E4QzVBIj48L3BhdGg+PHBhdGggZD0iTSAyIDUgTCAzIDUgTCAzIDYgTCAyIDYgTCAyIDUgWiIgZmlsbD0iIzdBOEM1QSI+PC9wYXRoPjxwYXRoIGQ9Ik0gMyA1IEwgNCA1IEwgNCA2IEwgMyA2IEwgMyA1IFoiIGZpbGw9IiM3QThDNUEiPjwvcGF0aD48cGF0aCBkPSJNIDQgNSBMIDUgNSBMIDUgNiBMIDQgNiBMIDQgNSBaIiBmaWxsPSIjN0E4QzVBIj48L3BhdGg+PHBhdGggZD0iTSA1IDUgTCA2IDUgTCA2IDYgTCA1IDYgTCA1IDUgWiIgZmlsbD0iIzdBOEM1QSI+PC9wYXRoPjxwYXRoIGQ9Ik0gNiA1IEwgNyA1IEwgNyA2IEwgNiA2IEwgNiA1IFoiIGZpbGw9IiM3QThDNUEiPjwvcGF0aD48cGF0aCBkPSJNIDcgNSBMIDggNSBMIDggNiBMIDcgNiBMIDcgNSBaIiBmaWxsPSIjMkUyQTI2Ij48L3BhdGg+PHBhdGggZD0iTSAwIDYgTCAxIDYgTCAxIDcgTCAwIDcgTCAwIDYgWiIgZmlsbD0iIzJFMkEyNiI+PC9wYXRoPjxwYXRoIGQ9Ik0gMSA2IEwgMiA2IEwgMiA3IEwgMSA3IEwgMSA2IFoiIGZpbGw9IiM3QThDNUEiPjwvcGF0aD48cGF0aCBkPSJNIDIgNiBMIDMgNiBMIDMgNyBMIDIgNyBMIDIgNiBaIiBmaWxsPSIjN0E4QzVBIj48L3BhdGg+PHBhdGggZD0iTSAzIDYgTCA0IDYgTCA0IDcgTCAzIDcgTCAzIDYgWiIgZmlsbD0iIzJFMkEyNiI+PC9wYXRoPjxwYXRoIGQ9Ik0gNCA2IEwgNSA2IEwgNSA3IEwgNCA3IEwgNCA2IFoiIGZpbGw9IiMyRTJBMjYiPjwvcGF0aD48cGF0aCBkPSJNIDUgNiBMIDYgNiBMIDYgNyBMIDUgNyBMIDUgNiBaIiBmaWxsPSIjMkUyQTI2Ij48L3BhdGg+PHBhdGggZD0iTSA2IDYgTCA3IDYgTCA3IDcgTCA2IDcgTCA2IDYgWiIgZmlsbD0iIzJFMkEyNiI+PC9wYXRoPjxwYXRoIGQ9Ik0gNyA2IEwgOCA2IEwgOCA3IEwgNyA3IEwgNyA2IFoiIGZpbGw9IiMyRTJBMjYiPjwvcGF0aD48cGF0aCBkPSJNIDAgNyBMIDEgNyBMIDEgOCBMIDAgOCBMIDAgNyBaIiBmaWxsPSIjMkUyQTI2Ij48L3BhdGg+PHBhdGggZD0iTSAxIDcgTCAyIDcgTCAyIDggTCAxIDggTCAxIDcgWiIgZmlsbD0iIzJFMkEyNiI+PC9wYXRoPjxwYXRoIGQ9Ik0gMiA3IEwgMyA3IEwgMyA4IEwgMiA4IEwgMiA3IFoiIGZpbGw9IiMyRTJBMjYiPjwvcGF0aD48cGF0aCBkPSJNIDMgNyBMIDQgNyBMIDQgOCBMIDMgOCBMIDMgNyBaIiBmaWxsPSIjMkUyQTI2Ij48L3BhdGg+PHBhdGggZD0iTSA0IDcgTCA1IDcgTCA1IDggTCA0IDggTCA0IDcgWiIgZmlsbD0iIzJFMkEyNiI+PC9wYXRoPjxwYXRoIGQ9Ik0gNSA3IEwgNiA3IEwgNiA4IEwgNSA4IEwgNSA3IFoiIGZpbGw9IiMyRTJBMjYiPjwvcGF0aD48cGF0aCBkPSJNIDYgNyBMIDcgNyBMIDcgOCBMIDYgOCBMIDYgNyBaIiBmaWxsPSIjMkUyQTI2Ij48L3BhdGg+PHBhdGggZD0iTSA3IDcgTCA4IDcgTCA4IDggTCA3IDggTCA3IDcgWiIgZmlsbD0iIzJFMkEyNiI+PC9wYXRoPjwvc3ZnPg==";

export function App() {
  const [download, setDownload] = useState(() => {
    const os = detectOS();
    return { os, label: downloadLabel(os), href: RELEASES_LATEST };
  });

  useEffect(() => {
    document.title = "DinoRip · Rip every image into clean textures";
  }, []);

  // Point the button at the matching installer from the latest GitHub release.
  // Falls back to the releases page if the lookup fails or there is no asset
  // for this OS (for example before the first release, or on a private repo).
  useEffect(() => {
    let cancelled = false;
    fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
      .then((res) => (res.ok ? res.json() : null))
      .then((release: { assets?: ReleaseAsset[] } | null) => {
        if (cancelled || !release?.assets) return;
        const href = pickAsset(download.os, release.assets);
        if (href) setDownload((prev) => ({ ...prev, href }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [download.os]);

  return (
    <div style="min-height:100vh;background:#171c17;color:#e7dec8;font-family:'Space Mono',monospace;overflow-x:hidden;">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap');
        @font-face{font-family:'Geist Pixel';font-style:normal;font-weight:400;font-display:swap;src:url('https://cdn.jsdelivr.net/npm/geist@1.7.2/dist/fonts/geist-pixel/GeistPixel-Square.woff2') format('woff2');}
        *{box-sizing:border-box;}
        html,body{margin:0;padding:0;background:#171c17;}
        ::selection{background:#8fa066;color:#171c17;}
        a{-webkit-tap-highlight-color:transparent;}
        .lb-nav-link:hover{color:#8fa066;}
        .lb-foot-link:hover{color:#8fa066;}
        .lb-btn-orange:hover{filter:brightness(1.08);}
        .lb-btn-tan:hover{filter:brightness(1.05);}
      `}</style>

      {/* ===== FLOATING NAV ===== */}
      <nav style="position:absolute;top:0;left:0;right:0;z-index:30;display:flex;align-items:center;gap:14px;padding:20px 26px;max-width:1000px;margin:0 auto;">
        <span style="font-family:'Geist Pixel',sans-serif;font-size:18px;letter-spacing:1px;color:#f4ecd9;">DinoRip</span>
        <div style="margin-left:auto;display:flex;gap:26px;align-items:center;">
          <a class="lb-nav-link" href="https://github.com/maria-rcks/dinorip" style="color:#f4ecd9;text-decoration:none;font-family:'Geist Pixel',sans-serif;font-size:15px;letter-spacing:1px;">GitHub</a>
        </div>
      </nav>

      {/* ===== HERO ===== */}
      <section style="position:relative;padding:96px 24px 0;background:#171c17;background-image:linear-gradient(45deg,rgba(0,0,0,.22) 25%,transparent 25%,transparent 75%,rgba(0,0,0,.22) 75%),linear-gradient(45deg,rgba(0,0,0,.22) 25%,transparent 25%,transparent 75%,rgba(0,0,0,.22) 75%);background-size:10px 10px;background-position:0 0,5px 5px;">
        <div style="position:relative;z-index:2;max-width:1000px;margin:0 auto;text-align:center;">
          <div style="display:inline-flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px 12px;background:#efe5c7;border:2px solid #000;box-shadow:inset 2px 2px 0 #fff8df,inset -3px -3px 0 #9c8f6c,4px 4px 0 #000;padding:10px 14px;color:#171c17;font-family:'Geist Pixel',sans-serif;font-size:12px;line-height:1.45;letter-spacing:1px;text-transform:uppercase;">
            <span>DinoRip is a remake of puck_psx&apos;s original texture ripper</span>
            <a href="https://puszke.itch.io/pucks-texture-ripper" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;background:#c46c3f;color:#fff;border:2px solid #000;box-shadow:inset 1px 1px 0 #e09666,inset -2px -2px 0 #934d28;padding:3px 9px;text-decoration:none;">
              Buy the original version
            </a>
          </div>
          <h1 style="font-family:'Geist Pixel',sans-serif;font-weight:700;font-size:clamp(42px,7.4vw,86px);line-height:1.02;letter-spacing:1px;margin:24px 0 0;color:#f4ecd9;">
            Rip every <span style="color:#8fa066;">image</span><br />into clean textures.
          </h1>
          <p style="font-family:'Space Mono',monospace;font-size:clamp(15px,1.9vw,19px);line-height:1.6;max-width:640px;margin:22px auto 0;color:#a3a890;">
            Drop in a photo, place the ripper over the surface you want, and pull a clean, flattened texture out in seconds.
          </p>
          <div id="download" style="display:flex;flex-wrap:wrap;gap:16px;justify-content:center;margin-top:34px;">
            <a class="lb-btn-orange" href={download.href} style="display:inline-flex;align-items:center;gap:10px;background:#c46c3f;color:#fff;border:2px solid #fff;box-shadow:inset 1px 1px 0 #e09666,inset -2px -2px 0 #934d28;padding:14px 24px;font-family:'Geist Pixel',sans-serif;font-size:19px;text-decoration:none;transition:filter .12s;">
              <span style="width:13px;height:13px;background:#fff;display:inline-block;"></span>
              {download.label}
            </a>
            <a class="lb-btn-tan" href="https://github.com/maria-rcks/dinorip" style="display:inline-flex;align-items:center;gap:10px;background:#cabd99;color:#000;border:2px solid #000;box-shadow:inset 1px 1px 0 #e6dab6,inset -2px -2px 0 #9c8f6c;padding:14px 24px;font-family:'Geist Pixel',sans-serif;font-size:19px;text-decoration:none;transition:filter .12s;">
              Star on GitHub
            </a>
          </div>
          <p style="margin-top:18px;font-size:12px;letter-spacing:1px;color:#6f7563;text-align:center;">
            Free &amp; open source — rip as much as you want
          </p>
        </div>

        {/* App window frame around screenshot */}
        <div style="position:relative;max-width:1000px;margin:60px auto 0;padding-bottom:40px;">
          <div style="border-radius:10px;overflow:hidden;">
            <img src={HERO_SHOT} alt="DinoRip texture atlas and image ripper" style="display:block;width:100%;" />
          </div>
        </div>
      </section>

      {/* ===== HOW ===== */}
      <section id="how" style="padding:48px 24px 96px;background:#171c17;background-image:linear-gradient(45deg,rgba(0,0,0,.18) 25%,transparent 25%,transparent 75%,rgba(0,0,0,.18) 75%),linear-gradient(45deg,rgba(0,0,0,.18) 25%,transparent 25%,transparent 75%,rgba(0,0,0,.18) 75%);background-size:10px 10px;background-position:0 0,5px 5px;">
        <div style="max-width:1040px;margin:0 auto;text-align:center;">
          <span style="display:inline-block;font-family:'Space Mono',monospace;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#8fa066;">// Three steps</span>
          <h2 style="font-family:'Geist Pixel',sans-serif;font-weight:700;font-size:clamp(28px,4.4vw,48px);line-height:1.05;margin:12px 0 0;color:#f4ecd9;">From image to <span style="color:#8fa066;">texture</span>.</h2>
          <div style="display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));margin-top:48px;text-align:left;">
            <div style="border:2px solid #000;background:#262d25;box-shadow:inset 1px 1px 0 #3a4338;padding:26px;">
              <div style="font-family:'Geist Pixel',sans-serif;font-size:54px;line-height:1;color:#8fa066;">01</div>
              <h3 style="font-family:'Geist Pixel',sans-serif;font-weight:600;font-size:20px;margin:14px 0 8px;color:#f0e7d2;">Load an image</h3>
              <p style="font-size:14px;line-height:1.55;margin:0;color:#9aa088;">Drag in any photo or screenshot that has the texture you want to pull.</p>
            </div>
            <div style="border:2px solid #000;background:#262d25;box-shadow:inset 1px 1px 0 #3a4338;padding:26px;">
              <div style="font-family:'Geist Pixel',sans-serif;font-size:54px;line-height:1;color:#c46c3f;">02</div>
              <h3 style="font-family:'Geist Pixel',sans-serif;font-weight:600;font-size:20px;margin:14px 0 8px;color:#f0e7d2;">Place the ripper</h3>
              <p style="font-size:14px;line-height:1.55;margin:0;color:#9aa088;">Drop the ripper window over the surface and match its corners to the perspective.</p>
            </div>
            <div style="border:2px solid #000;background:#262d25;box-shadow:inset 1px 1px 0 #3a4338;padding:26px;">
              <div style="font-family:'Geist Pixel',sans-serif;font-size:54px;line-height:1;color:#cabd99;">03</div>
              <h3 style="font-family:'Geist Pixel',sans-serif;font-weight:600;font-size:20px;margin:14px 0 8px;color:#f0e7d2;">Rip &amp; export</h3>
              <p style="font-size:14px;line-height:1.55;margin:0;color:#9aa088;">Browse everything captured, pick the textures you want, and export in a click.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ===== FOOTER ===== */}
      <footer style="background:#0c0f0a;border-top:2px solid #000;padding:30px 26px;">
        <div style="max-width:1000px;margin:0 auto;display:flex;flex-wrap:wrap;gap:18px;align-items:center;justify-content:space-between;">
          <div style="display:flex;align-items:center;gap:11px;">
            <img src={LOGO} width="28" height="28" alt="" style="image-rendering:pixelated;display:block;border:2px solid #000;background:#cabd99;" />
            <span style="font-family:'Geist Pixel',sans-serif;font-size:19px;font-weight:600;color:#e7dec8;">DinoRip</span>
          </div>
          <div style="display:flex;gap:20px;flex-wrap:wrap;align-items:center;">
            <a class="lb-foot-link" href="https://github.com/maria-rcks/dinorip" style="color:#9aa088;text-decoration:none;font-size:13px;">GitHub</a>
            <a class="lb-foot-link" href="https://ko-fi.com/maria_rcks" target="_blank" rel="noopener noreferrer" aria-label="Support DinoRip on Ko-fi" title="Support me on Ko-fi" style="color:#9aa088;display:inline-flex;align-items:center;">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M6 2v2" />
                <path d="M10 2v2" />
                <path d="M14 2v2" />
                <path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1" />
              </svg>
            </a>
            <a class="lb-foot-link" href="https://x.com/maria_rcks" target="_blank" rel="noopener noreferrer" aria-label="DinoRip on X" title="Follow on X" style="color:#9aa088;display:inline-flex;align-items:center;">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
