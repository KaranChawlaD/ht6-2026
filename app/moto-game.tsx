"use client";

import { useEffect, useState } from "react";

type GameModule = typeof import("./moto-game-engine-v2");

export default function MotoGameLoader() {
  const [Game, setGame] = useState<GameModule["default"] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let active = true;

    import("./moto-game-engine-v2")
      .then((module) => {
        if (active) setGame(() => module.default);
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });

    return () => {
      active = false;
    };
  }, []);

  if (loadFailed) {
    return (
      <main className="engine-loader engine-loader-error">
        <p>THE 3D ENGINE COULD NOT START.</p>
        <button type="button" onClick={() => window.location.reload()}>
          TRY AGAIN
        </button>
      </main>
    );
  }

  if (!Game) {
    return (
      <main
        className="engine-loader"
        aria-label="Loading motorcycle simulator"
        aria-busy="true"
      >
        <span />
      </main>
    );
  }

  return <Game />;
}
