# Chrome Web Store submission — Tallgrass

Everything needed to publish the extension. Upload page:
**https://chrome.google.com/webstore/devconsole/** (one-time $5 developer fee).

Package to upload: **`tallgrass-extension-vX.Y.zip`** (built from `extension/`, manifest at the zip root).

---

## Store listing fields (copy-paste)

**Item name**
```
Tallgrass — by MacRandle Acres
```

**Summary** (short description, max 132 chars)
```
Ranks the Facebook group and profile posts you browse against each group's own median, so the real outliers stand out.
```

**Detailed description**
```
Tallgrass turns the Facebook groups and profiles you already read into a ranked feed of what actually broke out.

As you scroll a group, Tallgrass captures each post you pass — its author, text, reactions, comments, shares, and image — and sends it to your own Tallgrass dashboard. There, every post is scored against the median for the group it came from, so a post with 3,000 reactions in a big group and one with 300 in a small one are judged on the same footing: how far past normal, for that group, did this land?

What you get:
• A single feed of the genuine outliers across every group you follow
• Each post scored against its own group's baseline, not a global one
• Reactions, comments, and shares captured as shown — never guessed
• A one-click way to find any captured post back in its group

Tallgrass reads only the pages you are already viewing while signed in to your own Facebook account. It does not log in for you, does not touch groups you are not a member of, and sends captured posts only to your own dashboard — never to us, never to advertisers.

Tallgrass is a product of MacRandle Acres. It is not affiliated with, endorsed by, or sponsored by Meta or Facebook.
```

**Category:** Productivity
**Language:** English

**Single purpose** (required statement)
```
Tallgrass captures posts from the Facebook groups and profiles the user is viewing and ranks each one against the median engagement of its own group, in the user's private dashboard.
```

---

## Permission justifications (review form)

| Permission | Justification to paste |
|---|---|
| `storage` | Stores the user's dashboard address and account key locally so they aren't re-entered on every use. |
| `activeTab` | Reads the Facebook tab the user is actively viewing, only while capturing. |
| `alarms` | Schedules periodic retry of undelivered captures and a background version check. |
| Host: `*.facebook.com` | The content script reads post content (author, text, engagement, image) from the Facebook pages the user is already viewing, which is the only way this data can be captured — there is no Facebook API for group post engagement. |
| Host: `*.onrender.com`, `localhost`, `127.0.0.1` | Sends captured posts to the user's own Tallgrass dashboard, which is hosted on Render or run locally. |
| Optional host: `https://*/*`, `http://*/*` | **Requested at runtime only, with an explicit user click,** when a user connects a self-hosted dashboard on a custom domain. Never requested or used otherwise. The default flow uses only the scoped hosts above. |

---

## Privacy practices (data disclosure tab)

- **What is collected:** the content of Facebook posts the user actively browses past — author name, post text, reaction/comment/share counts, image URLs, timestamps — plus the user's own account key.
- **Chrome data-type checkboxes to select:** **"Website content."** (Author names are public post content, not user-provided PII.)
- **Where it goes:** only the user's own Tallgrass dashboard server. Nothing is sent to MacRandle Acres or any third party.
- **Not** sold, **not** used for advertising or creditworthiness, **not** transferred except to the user's own dashboard.
- Attest to all three required certifications (no sale of data, no use beyond single purpose, no creditworthiness use).

**Privacy policy URL** (required):
```
https://outlier-q7ie.onrender.com/privacy
```
*(If you publish on a branded domain later, update this to that domain's `/privacy`.)*

---

## Screenshots (you supply — at least 1, up to 5; 1280×800 or 640×400 PNG/JPG)

Capture these from the live dashboard, ideally at 1280×800:
1. The main **feed** showing several ranked posts with their multiples/badges.
2. A **post detail** page (score bar + engagement).
3. The **Capture** page / extension popup connected to the dashboard.
4. (Optional) A group page showing the median "meadow."

Tip: a clean browser window at 1280×800 with a few real captured posts reads best. No promo tiles are required to publish.

---

## Build the upload package

From the repo root, zip the extension contents (NOT the folder itself — `manifest.json` must sit at the zip root):

```bash
cd extension && zip -r ../tallgrass-extension.zip . -x '*.DS_Store'
```

Or on Windows PowerShell:

```powershell
Compress-Archive -Path extension\* -DestinationPath tallgrass-extension.zip -Force
```

Verify the zip has `manifest.json` at its top level and includes the `icons/` folder.

---

## Submit checklist

- [ ] $5 developer account registered
- [ ] `tallgrass-extension-vX.Y.zip` uploaded (manifest at root, icons included)
- [ ] Name, summary, detailed description filled from above
- [ ] Category = Productivity, Language = English
- [ ] Single-purpose statement pasted
- [ ] Each permission justified from the table above
- [ ] Privacy policy URL set; "Website content" disclosed; 3 certifications attested
- [ ] ≥1 screenshot at 1280×800 uploaded
- [ ] Submit for review (first review typically a few business days)
