/* Aplica el tema guardado antes de pintar, para evitar parpadeo. */
(function () {
  try {
    if (localStorage.getItem('bc-theme') === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    }
  } catch (e) {}
})();
