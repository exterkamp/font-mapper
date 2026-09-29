# Font Mapper

Print a template, fill it in by hand, scan it back in, download a font built from your handwriting.

No backend — everything runs client-side in the browser.

## Run

```
npm run serve
```

Then open the printed URL and use the "Print Template" and "Scan & Build Font" tabs.

## Test

```
npm install
npm test           # Node unit tests
npm run test:browser   # Puppeteer-driven browser tests (needs Chrome + a running `npm run serve`)
```

## License

[CC0 1.0](LICENSE) — public domain.
