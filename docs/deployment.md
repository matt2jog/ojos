# Ojos deployment

Develop on `dev`. A push to `dev` runs checks and deploys `ojos-dev`. Open a pull request from `dev` to `main` to promote the same changes. Merging runs the checks and deploys `ojos-prod`. Both Cloud Run services are in `us-east1` in `ojos-matt2jog`. Both scale to zero and may incur a cold start. GitHub Actions authenticates using Workload Identity Federation and uses a separate deploy identity for each service.

## Set the Gemini key

The services use the latest version of the `ojos-gemini-key` Secret Manager secret. The initial version is an unconfigured marker. Add the new key from a file containing only the key, or add it directly in Secret Manager. A new version does not require rebuilding the image.

```sh
gcloud secrets versions add ojos-gemini-key --project=ojos-matt2jog --data-file=/path/to/key.txt
```

On either service, `GET /healthz` shows whether the key is configured. It does not send a Gemini request. A successful end-to-end check also requires a key with access to the models used by Ojos, including Gemini 4 Hydrogen for the default clip and chat paths.

## Configure the desktop

Copy the repository’s `.env.example` to `.env`. Source builds use that file from the repository root. Installed builds read `.env` in the Electron user data directory.

| Scope | Clip analysis and chat |
| --- | --- |
| `local` | Loopback assistant. Add a local `GEMINI_API_KEY`. |
| `dev` | Ojos development Cloud Run service. Set `OJOS_CLOUD_TOKEN` to the dev service token. |
| `prod` | Ojos production Cloud Run service. Set `OJOS_CLOUD_TOKEN` to the prod service token. |
| `remote` | Existing custom `/v1/jobs` endpoint. Set `OJOS_ASSISTANT_URL` and `OJOS_LOCAL_TOKEN`. Chat still uses the local Gemini key. |

The Google Cloud CLI can look up the selected service and its access token under your existing login. Run the secret-access command in a private terminal and place the returned token in the ignored desktop `.env`.

```sh
gcloud run services describe ojos-dev --project=ojos-matt2jog --region=us-east1 --format='value(status.url)'
gcloud secrets versions access 1 --secret=ojos-dev-token --project=ojos-matt2jog
```

For cloud scopes, chat orchestration, history, camera frames, calibration, and file tools stay on the laptop. Cloud Run receives the screen clip and gaze data for analysis and relays the model requests from chat. It does not keep chat databases or clips between requests. The cloud clip call can be abandoned by the desktop. An upstream model request may finish after a disconnect.

## Debug vision

From `apps/desktop`, use `npm run dev` to run a dev build or `npm run package:dev` to package Ojos Dev in `apps/desktop/release-dev` with the usual staged runtime. Ojos Dev uses its own application ID and profile. Open **Settings → Vision debugging → Open preview** during an active capture session. The preview shows the webcam on the left and the model points, mean, and max box in display coordinates on the right. The chart shows the rolling confidence score, the current threshold, and finalized intervals as shaded bands. Webcam previews are generated on demand and stay on device. Screen capture and detection continue while the preview is open. Assistant clip and screenshot requests resume once fresh footage is available after closing the preview. The normal production build omits this panel.

Use the command line for the last annotated replay or to watch for the next live automatic clip:

```sh
node testing/preview-last-segment.mjs --path
node testing/preview-last-segment.mjs --watch
```

To pass a saved screen bundle directly to the cloud backend, set `OJOS_CLOUD_TOKEN` in your shell, then run:

```sh
node agentic_system/assistant/desktop-client.mjs /path/to/bundle https://ojos-dev-472273737799.us-east1.run.app --cloud
```
