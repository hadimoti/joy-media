# Semantic Naming Input

The Python CLI does not embed a heavyweight vision model. Let Codex or another trusted vision provider inspect isolated PNGs/contact sheets, then provide one JSON object per line through --semantic-jsonl.

Use the key "<source-relative-path>#<crop-index>", where crop indexes follow the left-to-right, top-to-bottom group order in a source sheet.

~~~json
{"key":"archive/sheet-014.png#1","name":"gold-curved-left-arrow","category":"arrow","description":"A metallic gold arrow curving toward the left.","tags":["gold","arrow","curved","left","navigation"],"colors":["gold","yellow"],"orientation":"left","confidence":0.94}
~~~

Use only visible facts. Keep name lowercase English and compact. Allowed categories are icon, ui, character, person, body-part, object, text, logo, shape, arrow, effect, fire, smoke, light, particle, background, decoration, and unknown.

If no reliable model result exists, omit the line. The extractor will retain its deterministic fallback and add the asset to the review queue.
