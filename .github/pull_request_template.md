## Summary

<!-- What changed and why. Link the issue if there is one. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Performance or memory improvement
- [ ] Accessibility or responsive UI
- [ ] Refactor or test-only change
- [ ] Documentation or tooling

## Affected areas

- [ ] PDF viewer / extraction / OCR
- [ ] Text or formatted document reader
- [ ] Playback, highlighting, or TTS
- [ ] History or local storage
- [ ] UI, theming, or accessibility
- [ ] Android / Capacitor
- [ ] CI, build, or tooling

## How this was tested

<!-- Commands run, documents used, browsers/devices checked. -->

```
npx tsc --noEmit
npm run lint
npm test
npm run build
```

- Large PDF tested (pages, text-based/scanned):
- Mobile width tested:
- Android build tested (`npm run mobile:sync`):

## Checklist

- [ ] The generated `nextjs-agent-rules` block in `AGENTS.md` is unchanged.
- [ ] Type check, lint, tests, and static build pass.
- [ ] New tests are registered in `tests/run.mjs`.
- [ ] Segment indices stay stable and appending pages preserves playback.
- [ ] `pdfjs-dist` and `public/pdf.worker.min.mjs` versions still match.
- [ ] Lazy page rendering and eviction are intact.
- [ ] Selection maps to the correct sentence in every viewer.
- [ ] Math speech is applied at synthesis/export only.
- [ ] No pasted text is persisted, no documents are uploaded, and no telemetry was added.
- [ ] The tools launcher still opens this deployment locally.
- [ ] Generated Android assets were refreshed with `cap sync`, not edited by hand.
- [ ] No contributor names, emails, or handles were added to source or docs.

## Screenshots

<!-- Before/after images or a short recording for UI changes. Remove this section if not applicable. -->

## Notes for reviewers

<!-- Trade-offs, follow-ups, or areas that need extra attention. -->
