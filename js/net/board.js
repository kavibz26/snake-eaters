// Live in-match leaderboard. The ORDER, the scores and the alive flags all come from the
// server (snapshot `lb`); this only draws them. Rows are reused and only touched when
// their text/state actually changes, so the ~7 updates per second cost almost nothing.
export function createBoard(root) {
  const rows = new Map(); // player id -> { li, rank, name, score, alive, key }
  let lastOrder = '';

  function makeRow(row) {
    const li = document.createElement('li');
    li.className = 'board-row';
    const rank = document.createElement('span');
    rank.className = 'board-rank';
    const dot = document.createElement('span');
    dot.className = 'board-dot';
    dot.style.background = row.color;
    const name = document.createElement('span');
    name.className = 'board-name';
    name.textContent = row.name;
    const score = document.createElement('span');
    score.className = 'board-score';
    li.append(rank, dot, name, score);
    return { li, rank, score, key: '' };
  }

  return {
    update(list) {
      const order = list.map((r) => r.id).join(',');
      for (const r of list) {
        let entry = rows.get(r.id);
        if (!entry) {
          entry = makeRow(r);
          rows.set(r.id, entry);
        }
        const key = `${r.rank}|${r.score}|${r.alive}|${r.isMe}`;
        if (key !== entry.key) {
          entry.key = key;
          entry.rank.textContent = r.rank;
          entry.score.textContent = r.score;
          entry.li.classList.toggle('board-row--me', r.isMe);
          entry.li.classList.toggle('board-row--dead', !r.alive);
          entry.li.title = r.alive ? '' : 'Eliminated';
        }
      }
      if (order !== lastOrder) {
        lastOrder = order;
        for (const r of list) root.appendChild(rows.get(r.id).li); // moves existing nodes into rank order
      }
    },
    clear() {
      rows.clear();
      lastOrder = '';
      root.textContent = '';
    },
  };
}
