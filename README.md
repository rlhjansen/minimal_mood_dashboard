# minimal_mood_dashboard
minimalistic journalling page based on PANAS

literally just open the html in chrome & u ready to go.

<img width="1726" height="819" alt="image" src="example.PNG" />

got inspired by post from [forth](https://x.com/forthrighter/status/1957524801377169619) & tried to make it relatively self contained so it's "runnable" by just opening it in chrome so it even works if you don't know what you're doing but is amenable to be adaptated.

## Intent Calibration Module

A lightweight **3-hour check-in** system sits below the PANAS dashboard:

| Feature | Details |
|---|---|
| **Retrospective / Prospective** | Free-text "What did I do?" → "What's my intent for the next block?" |
| **Target direction** | Concise phrase you're steering toward (e.g. "Ship parsing module") |
| **Alignment scoring** | Cosine similarity between previous intent and current retrospective. Uses sentence embeddings (Transformers.js) when served via http, bag-of-words fallback from `file://` |
| **Drift feedback** | Neutral prompt when alignment drops below threshold — "Was this shift intentional or reactive?" |
| **Collapse early warning** | Rolling 7-day heuristic across sleep, PANAS strain signals, and alignment trend. Suggests 10% downshift when ≥ 2 flags fire |
| **Notifications** | Browser `Notification` API reminders every 3 hours (08:00–20:00), configurable |

### Semantic similarity (optional)

For best alignment scoring, serve the dashboard from a local server so the embedding model can load:

```bash
python -m http.server 8000
# then open http://localhost:8000/panas.html
```

From `file://` everything works — alignment just uses text-overlap instead of embeddings.

### Files

```
panas.html          – main dashboard (PANAS windrose + timeseries)
js/intent.js        – intent calibration module (check-in, alignment, collapse warning)
README.md
```
