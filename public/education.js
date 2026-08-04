const signup = document.querySelector('.signup');
const signupStatus = document.querySelector('#signupStatus');

signup?.addEventListener('submit', (event) => {
  event.preventDefault();
  const button = signup.querySelector('button[type="submit"]');
  if (!button || !signupStatus) return;

  button.disabled = true;
  button.textContent = 'Saving spot...';
  window.setTimeout(() => {
    button.disabled = false;
    button.textContent = 'Join the sprint';
    signupStatus.textContent = "You're on the list. A starter quest preview is ready for your inbox.";
  }, 350);
});
