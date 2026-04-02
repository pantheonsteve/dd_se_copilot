/**
 * Shared markdown rendering helpers.
 */
const MD = {
  render(text) {
    if (!text) return "";
    return marked.parse(text);
  },

  shortSource(s) {
    const parts = s.replace(/\\/g, "/").split("/");
    return parts.slice(-2).join("/");
  },

  timeAgo(dateStr) {
    const now = new Date();
    const d = new Date(dateStr);
    const diffMs = now - d;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + "h ago";
    const days = Math.floor(hours / 24);
    if (days < 7) return days + "d ago";
    return d.toLocaleDateString();
  },

  formatDate(dateStr) {
    return new Date(dateStr).toLocaleDateString(undefined, {
      month: "short", day: "numeric", year: "numeric",
    });
  },

  confBadge(label, level) {
    return '<span class="badge conf-' + level + '">' + label + ": " + level + "</span>";
  },

  escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  },
};
