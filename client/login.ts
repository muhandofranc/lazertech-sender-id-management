(() => {
  const form = document.getElementById('login-form') as HTMLFormElement;
  const errorBox = document.getElementById('login-error') as HTMLDivElement;
  const submit = document.getElementById('login-submit') as HTMLButtonElement;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    submit.disabled = true;

    const username = (document.getElementById('username') as HTMLInputElement).value;
    const password = (document.getElementById('password') as HTMLInputElement).value;

    void fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
      .then(async (res) => {
        if (res.ok) {
          window.location.href = '/';
          return;
        }
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        errorBox.textContent = body.error ?? 'Sign in failed';
        errorBox.hidden = false;
        submit.disabled = false;
      })
      .catch(() => {
        errorBox.textContent = 'Could not reach the server';
        errorBox.hidden = false;
        submit.disabled = false;
      });
  });
})();
