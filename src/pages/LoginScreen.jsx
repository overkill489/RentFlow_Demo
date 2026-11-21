import { useState } from "react";
import { LockKeyhole, Truck, LogOut } from "lucide-react";
import { rentflowApi } from "../services/rentflowApi";
import "./LoginScreen.css";

export default function LoginScreen({ onAuthenticated }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState(null);
  const [quotes, setQuotes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleLogin(event) {
    event.preventDefault();
    if (loading) return;

    setLoading(true);
    setError("");

    try {
      const loggedInUser = await rentflowApi.login(email.trim(), password);

      if (onAuthenticated) {
        onAuthenticated(loggedInUser);
        return;
      }

      setUser(loggedInUser);
    } catch (error) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    setLoading(true);
    setError("");

    try {
      await rentflowApi.logout();
      setUser(null);
      setQuotes([]);
      setEmail("");
      setPassword("");
    } catch (error) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="rf-login-page">
      <div className="rf-login-container">
        <div className="rf-login-brand">
          <div className="rf-login-logo">
            <Truck size={28} />
          </div>
          <div>
            <h1>RENTFLOW</h1>
            <p>QUOTE AUTOMATION</p>
          </div>
        </div>

        {user ? (
          <section className="rf-login-card">
            <div className="rf-login-success">
              <LockKeyhole size={25} />
            </div>

            <span className="rf-login-eyebrow">AUTHENTICATED SESSION</span>

            <h2>Welcome back</h2>

            <p className="rf-login-description">
              You're securely connected to your company's RentFlow account.
            </p>

            <div className="rf-account-details">
              <div>
                <span>Company</span>
                <strong>{user.companyName}</strong>
              </div>

              <div>
                <span>Email</span>
                <strong>{user.email}</strong>
              </div>

              <div>
                <span>Account role</span>
                <strong>{user.role}</strong>
              </div>

              <div>
                <span>Company quotes</span>
                <strong>{quotes.length}</strong>
              </div>
            </div>

            {error && (
              <p className="rf-login-error" role="alert">
                {error}
              </p>
            )}

            <button
              type="button"
              className="rf-login-button"
              onClick={handleLogout}
              disabled={loading}
            >
              <LogOut size={18} />
              {loading ? "Logging out..." : "Log Out"}
            </button>
          </section>
        ) : (
          <section className="rf-login-card">
            <span className="rf-login-eyebrow">RENTFLOW ACCOUNT</span>

            <h2>Welcome back</h2>

            <p className="rf-login-description">
              Sign in to access your rental quotes and follow-up management.
            </p>

            <form onSubmit={handleLogin}>
              <label htmlFor="rf-email">Email address</label>

              <input
                id="rf-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@company.com"
                autoComplete="username"
                required
              />

              <label htmlFor="rf-password">Password</label>

              <input
                id="rf-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Enter your password"
                autoComplete="current-password"
                required
              />

              {error && (
                <p className="rf-login-error" role="alert">
                  {error}
                </p>
              )}

              <button
                type="submit"
                className="rf-login-button"
                disabled={loading}
              >
                <LockKeyhole size={18} />
                {loading ? "Signing in..." : "Sign In"}
              </button>
            </form>

            <p className="rf-login-footer">
              Authorized rental company accounts only.
            </p>
          </section>
        )}

        <p className="rf-login-bottom">
          RentFlow · Local development environment
        </p>
      </div>
    </main>
  );
}
