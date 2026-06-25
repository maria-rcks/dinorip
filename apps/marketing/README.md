# DinoRip marketing site

The DinoRip landing page, built as a [Lakebed](https://lakebed.dev) capsule and
deployed to **https://dinorip.lakebed.app**.

The page is fully client-rendered; `server/index.ts` is an empty capsule that
only satisfies the runtime.

## Develop

```sh
npx lakebed dev apps/marketing
```

## Deploy

Pushes to `main` that touch `apps/marketing/**` deploy automatically via the
`Deploy marketing` GitHub Actions workflow. To deploy by hand:

```sh
npx lakebed deploy apps/marketing
```

The hero screenshot lives in `assets/app-shot.png` and is served from the public
GitHub raw URL referenced in `client/index.tsx`.
