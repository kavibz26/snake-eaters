// Room chat view. Messages arrive already sanitised by the server, and are still
// rendered with textContent only (never innerHTML), so chat text can never inject markup.
const MAX_LINES = 60;

export function createChat({ log, form, input, onSend }) {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    onSend(text);
    input.value = '';
  });

  function nearBottom() {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  }

  function append(line) {
    const stick = nearBottom();
    log.appendChild(line);
    while (log.childElementCount > MAX_LINES) log.removeChild(log.firstElementChild);
    if (stick) log.scrollTop = log.scrollHeight;
  }

  return {
    add(msg, meId) {
      const line = document.createElement('div');
      line.className = 'chat-line' + (msg.id === meId ? ' chat-line--me' : '');
      const time = new Date(msg.ts);
      if (!Number.isNaN(time.getTime())) line.title = time.toLocaleTimeString();
      const name = document.createElement('span');
      name.className = 'chat-name';
      name.textContent = msg.name;
      const text = document.createElement('span');
      text.className = 'chat-text';
      text.textContent = msg.m;
      line.append(name, text);
      append(line);
    },
    notice(text) {
      const line = document.createElement('div');
      line.className = 'chat-line chat-line--sys';
      line.textContent = text;
      append(line);
    },
    clear() {
      log.textContent = '';
    },
    focus() {
      input.focus();
    },
    get input() {
      return input;
    },
  };
}
