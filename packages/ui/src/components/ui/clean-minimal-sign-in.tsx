import { ChevronDown, Eye, EyeOff, Lock, User } from "lucide-react";
import { useState } from "react";
import { DEMO_ACCOUNTS } from "../../auth.js";

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

  const fillAccount = (username: string, password: string) => {
    setUsername(username);
    setPassword(password);
    setError("");
  };

  const handleSignIn = async () => {
    if (!username.trim() || !password) {
      setError("Enter both username and password.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSubmit(username.trim(), password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="signin-minimal min-h-full w-full flex items-center justify-center bg-[#07090e] z-1 overflow-auto py-12 px-6">
      <div className="w-full max-w-lg bg-[#0e131b] rounded-xl border border-[#1c2433] shadow-[0_20px_40px_-15px_rgba(0,0,0,0.8),inset_0_1px_0_0_rgba(255,255,255,0.06)] p-8 sm:p-10 flex flex-col">
        {/* Brand Header */}
        <div className="flex items-center justify-between border-b border-[#1c2433] pb-6 mb-7">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="w-7 h-7 rounded bg-blue-600 text-white font-mono font-bold text-xs flex items-center justify-center border border-blue-400/30">
                CL
              </span>
              <span className="font-semibold text-lg text-white tracking-tight">CoreLogistics</span>
            </div>
            <p className="text-xs text-slate-400 mt-1">Fleet, yard & warehouse operations console</p>
          </div>
          <span className="text-[11px] font-mono font-medium px-2 py-0.5 rounded bg-[#161f2e] text-blue-400 border border-[#233147]">
            v2.4·PROD
          </span>
        </div>

        <form
          className="flex flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSignIn();
          }}
        >
          <div className="flex flex-col gap-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-1.5" htmlFor="signin-username">
                Operator ID
              </label>
              <div className="relative">
                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500">
                  <User className="w-4 h-4" aria-hidden />
                </span>
                <input
                  id="signin-username"
                  placeholder="Username"
                  type="text"
                  name="username"
                  autoComplete="username"
                  autoFocus
                  aria-label="Operator ID"
                  value={username}
                  className="w-full pl-10 pr-3.5 py-2.5 rounded-lg border border-[#222c3d] focus:outline-none focus:border-blue-500 focus:bg-[#07090e] bg-[#0a0e16] text-white placeholder-slate-500 text-sm font-sans transition-colors"
                  onChange={(e) => {
                    setUsername(e.target.value);
                    setError("");
                  }}
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-1.5" htmlFor="signin-password">
                Passcode
              </label>
              <div className="relative">
                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500">
                  <Lock className="w-4 h-4" aria-hidden />
                </span>
                <input
                  id="signin-password"
                  placeholder="Password"
                  type={showPassword ? "text" : "password"}
                  name="password"
                  autoComplete="current-password"
                  aria-label="Passcode"
                  value={password}
                  className="w-full pl-10 pr-10 py-2.5 rounded-lg border border-[#222c3d] focus:outline-none focus:border-blue-500 focus:bg-[#07090e] bg-[#0a0e16] text-white placeholder-slate-500 text-sm font-sans transition-colors"
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError("");
                  }}
                />
                <button
                  type="button"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 cursor-pointer p-1 rounded"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error ? (
              <div className="p-3 rounded-md bg-rose-950/40 border border-rose-900/60 text-xs font-medium text-rose-300">
                {error}
              </div>
            ) : null}
          </div>

          <button
            type="submit"
            disabled={busy}
            className="w-full font-medium py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white text-sm shadow-[inset_0_1px_0_0_rgba(255,255,255,0.2)] border border-blue-500 transition-all cursor-pointer mt-5 disabled:opacity-50 disabled:cursor-default"
          >
            {busy ? "Authenticating Session…" : "Sign In to Terminal"}
          </button>
        </form>

        {/* Demo Fast Logins */}
        <div className="mt-8 pt-6 border-t border-[#1c2433]">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Assigned Demo Stations
            </span>
            <span className="text-[10px] text-slate-500 font-mono">1-CLICK LOGIN</span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {PRIMARY.map((a) => (
              <button
                key={a.username}
                type="button"
                className="flex flex-col items-start p-2.5 rounded-lg border border-[#1e2738] bg-[#0a0e16] hover:bg-[#121926] hover:border-blue-500/50 transition-colors text-left cursor-pointer group"
                onClick={() => {
                  fillAccount(a.username, a.password);
                  setMorePick("");
                }}
              >
                <span className="text-xs font-semibold text-white group-hover:text-blue-400 transition-colors">
                  {a.title}
                </span>
                <span className="text-[11px] text-slate-400 mt-0.5 font-mono">
                  {a.name} ({a.username})
                </span>
              </button>
            ))}
          </div>

          <div className="relative mt-3">
            <select
              aria-label="More fleet driver accounts"
              value={morePick}
              className="w-full appearance-none py-2 pl-3 pr-8 rounded-lg border border-[#1e2738] bg-[#0a0e16] text-xs text-slate-300 focus:outline-none focus:border-blue-500 cursor-pointer"
              onChange={(e) => {
                const id = e.target.value;
                setMorePick(id);
                const account = MORE.find((a) => a.username === id);
                if (account) fillAccount(account.username, account.password);
              }}
            >
              <option value="" className="bg-[#0e131b] text-slate-400">Select active truck driver account…</option>
              {MORE.map((a) => (
                <option key={a.username} value={a.username} className="bg-[#0e131b] text-slate-200">
                  {a.name} · {a.username} ({a.title})
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" aria-hidden />
          </div>
        </div>
      </div>
    </div>
  );
}
