# Layer 3 — Google Drive uploads (n8n)

The repo workflow [`wf_layer3_creative_pack.json`](../n8n/wf_layer3_creative_pack.json) persists **Midjourney prompt text**, **OpenAI image metadata**, and **SVG markup** in Postgres (`creative_generation_run`, `creative_output`). Raster PNG bytes are **not** stored in the database.

By default the Code node sets **`LAYER3_SKIP_DRIVE_UPLOAD=true`** (see [`n8n/snippets/layer3_generate_creative_pack.js`](../n8n/snippets/layer3_generate_creative_pack.js)): no Drive calls are made. To attach uploads:

1. Set **`LAYER3_SKIP_DRIVE_UPLOAD=false`** in the n8n environment (or execution environment for the worker).
2. In n8n, create an OAuth2 credential for Google Drive (least-privilege folder scope).
3. After **Generate creative pack**, insert **Google Drive → Folder → Create** under a parent folder ID you control; pass **`folderId`** / **`driveId`** from the credential UI.
4. Add **Google Drive → File → Upload** for each artifact:
   - Decode OpenAI `b64_json` into binary property names (`openai_01.png`, …).
   - Upload `mj_prompts.md` from the Markdown string in `creative_output` (`kind = mj_prompt_bundle`).
   - Upload `sample.svg` from SVG `body_text` (`kind = svg_sample`).
5. **`UPDATE creative_generation_run`** with `drive_folder_id` / `drive_folder_url` using **Postgres** nodes (optional follow-up workflow).

Regenerate the workflow JSON after editing the builder: `npm run n8n:build-layer3`.
