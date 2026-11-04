// The big box at the top of the page for somebody who is not logged in: what TradeQuest is, how to start in three steps, and two big
// buttons ("Create free account", "Log in") that open the same window as the buttons in the top bar. It is only shown while nobody is
// logged in; it is gone the moment the log in works. It decides nothing: the server makes the account.
import { sharedStore } from './store';

export function WelcomeCard() {
  return (
    <section className="card welcome-card" aria-label="Welcome to TradeQuest" data-testid="welcome-card">
      <div className="welcome-main">
        <h2 className="welcome-title">New here? Make a free account and start playing</h2>
        <ol className="welcome-steps">
          <li>
            <span className="welcome-num" aria-hidden="true">
              1
            </span>
            <span>
              Press <strong>Create free account</strong> and pick a username and a password. No email needed.
            </span>
          </li>
          <li>
            <span className="welcome-num" aria-hidden="true">
              2
            </span>
            <span>
              You get <strong>$1,000</strong> of pretend money.
            </span>
          </li>
          <li>
            <span className="welcome-num" aria-hidden="true">
              3
            </span>
            <span>Buy your first stock and watch its price move.</span>
          </li>
        </ol>
        <p className="welcome-note">
          Everything here is pretend: made-up companies and fake money. You can look around without an account, but you need one to trade, chat and keep your
          progress.
        </p>
      </div>
      <div className="welcome-actions">
        <button type="button" className="btn btn-primary welcome-create" onClick={() => sharedStore.openAuth('register')} data-testid="welcome-register">
          Create free account
        </button>
        <span className="welcome-have">Already have an account?</span>
        <button type="button" className="btn welcome-login" onClick={() => sharedStore.openAuth('login')} data-testid="welcome-login">
          Log in
        </button>
      </div>
    </section>
  );
}
