import { ChevronDown, Eye, EyeOff, Lock, User } from "lucide-react";
import { useRef, useState } from "react";
import { DEMO_ACCOUNTS } from "../../auth.js";
import { useSignInMotion } from "../../motion.js";

const PRIMARY_IDS = ["ava", "rico", "mina", "jose"];
const PRIMARY = DEMO_ACCOUNTS.filter((a) => PRIMARY_IDS.includes(a.username));
const MORE = DEMO_ACCOUNTS.filter((a) => !PRIMARY_IDS.includes(a.username));

export function SignIn2({
  onSubmit,
}: {
  onSubmit: (username: string, password: string) => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [morePick, setMorePick] = useState("");
  const stageRef = useRef<HTMLDivElement>(null);
  useSignInMotion(stageRef);

  const signInAs = async (nextUsername: string, nextPassword: string) => {
    const id = nextUsername.trim();
    setUsername(nextUsername);
    setPassword(nextPassword);
    if (!id || !nextPassword) {
      setError("Enter both username and password.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSubmit(id, nextPassword);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="signin-stage" ref={stageRef}>
      <div className="signin-card">
        {/* Brand Header */}
        <div className="signin-brand">
          <div className="signin-identity">
            <span className="signin-mark">CL</span>
            <div className="signin-title">CoreLogistics</div>
          </div>
          <span className="signin-version">v2.4 · PROD</span>
          <p className="signin-sub">Fleet, yard & warehouse operations console</p>
        </div>

        <form
          className="signin-form"
          onSubmit={(e) => {
            e.preventDefault();
            void signInAs(username, password);
          }}
        >
          <div className="signin-fields">
            <div className="signin-field">
              <label htmlFor="signin-username">Operator ID</label>
              <div className="signin-control">
                <User aria-hidden />
                <input
                  id="signin-username"
                  placeholder="Username"
                  type="text"
                  name="username"
                  autoComplete="username"
                  autoFocus
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value);
                    setError("");
                  }}
                />
              </div>
            </div>

            <div className="signin-field">
              <label htmlFor="signin-password">Passcode</label>
              <div className="signin-control">
                <Lock aria-hidden />
                <input
                  id="signin-password"
                  placeholder="Password"
                  type={showPassword ? "text" : "password"}
                  name="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError("");
                  }}
                />
                <button
                  type="button"
                  className="signin-reveal"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                </button>
              </div>
            </div>

            {error ? <div className="signin-error" role="alert">{error}</div> : null}
          </div>

          <button type="submit" className="signin-submit" disabled={busy}>
            {busy ? "Authenticating session…" : "Sign in to terminal"}
          </button>
        </form>

        <div className="signin-stations">
          <div className="signin-stations-head">
            <span>Assigned demo stations</span>
            <span>1-click login</span>
          </div>

          <div className="signin-station-grid">
            {PRIMARY.map((a) => (
              <button
                key={a.username}
                type="button"
                className="signin-station"
                disabled={busy}
                onClick={() => {
                  setMorePick("");
                  void signInAs(a.username, a.password);
                }}
              >
                <span className="signin-station-title">{a.title}</span>
                <span className="signin-station-meta">{a.name} ({a.username})</span>
              </button>
            ))}
          </div>

          <div className="signin-more">
            <select
              aria-label="More fleet driver accounts"
              value={morePick}
              disabled={busy}
              onChange={(e) => {
                const id = e.target.value;
                setMorePick(id);
                const account = MORE.find((a) => a.username === id);
                if (account) void signInAs(account.username, account.password);
              }}
            >
              <option value="">Select active truck driver account…</option>
              {MORE.map((a) => (
                <option key={a.username} value={a.username}>
                  {a.name} · {a.username} ({a.title})
                </option>
              ))}
            </select>
            <ChevronDown aria-hidden />
          </div>
        </div>
      </div>
    </div>
  );
}
