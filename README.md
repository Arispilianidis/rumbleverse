# Rooftop Rumble

3D one-on-one rooftop brawler. Light/heavy strikes, block, dodge, grab and throw. Offline vs bot or a friend on one keyboard, or online with rollback netcode.

## Files
- `index.html` the game (Three.js and PeerJS load from cdnjs)
- `sim.js` deterministic 60 Hz combat simulation (also runs in Node)
- `net.js` rollback netcode (transport-agnostic)
- `server.js` optional: static server plus a WebSocket relay (not used by the GitHub Pages build)

## Host on GitHub Pages (free)
1. Create a new public repository on GitHub.
2. Upload `index.html`, `sim.js` and `net.js` (the `site/` folder has exactly these).
3. Repository Settings > Pages > Build and deployment: Source "Deploy from a branch", branch `main`, folder `/ (root)`.
4. After a minute the game is at `https://<your-name>.github.io/<repo>/`.

Online play: one player clicks Online > Host and shares the 4-letter code or the invite link. The other opens the page, clicks Online and enters the code. Players connect directly (WebRTC); PeerJS's free public broker only introduces them. Strict networks may block direct connections.

## Run locally
    npm install
    node server.js     # http://localhost:3000
