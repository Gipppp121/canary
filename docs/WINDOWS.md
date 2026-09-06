# Windows / CMD setup

From the folder that contains `package.json`:

```bat
npm install
npm test
npm run typecheck
npm run build
npm run canary -- watch --demo
npm run canary -- doctor --probe
```

To push into a new empty GitHub repository named `canary`:

```bat
git init
git add .
git commit -m "canary: read-only pons v2 watchtower"
git branch -M main
git remote add origin https://github.com/Gipppp121/canary.git
git push -u origin main
```

If `origin` already exists:

```bat
git remote set-url origin https://github.com/Gipppp121/canary.git
git push -u origin main
```

After the first push, GitHub Actions should run the `ci` workflow automatically.
