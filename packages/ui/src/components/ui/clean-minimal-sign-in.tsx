import { ChevronDown, Eye, EyeOff, Lock, LogIn, User } from "lucide-react";
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
    <div className="signin-minimal min-h-full w-full flex items-center justify-center bg-white z-1 overflow-auto py-10 px-6">
      <form
        className="w-full max-w-xl bg-gradient-to-b from-sky-50/50 to-white rounded-[2rem] shadow-xl p-10 sm:p-12 flex flex-col items-center border border-blue-100 text-black"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSignIn();
        }}
      >
        <div className="flex items-center justify-center w-16 h-16 rounded-2xl bg-white mb-7 shadow-lg">
          <LogIn className="w-8 h-8 text-black" />
        </div>
        <h2 className="text-3xl font-semibold mb-3 text-center tracking-tight">Sign in with your account</h2>
        <p className="text-gray-500 text-base mb-8 text-center leading-relaxed max-w-md">
          Use the username and password issued for your job. There is no self-signup.
        </p>
        <div className="w-full flex flex-col gap-4 mb-2">
          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">
              <User className="w-5 h-5" aria-hidden />
            </span>
            <input
              placeholder="Username"
              type="text"
              name="username"
              autoComplete="username"
              autoFocus
              aria-label="Username"
              value={username}
              className="w-full pl-12 pr-4 py-3.5 min-h-12 rounded-2xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-200 bg-gray-50 text-black text-base"
              onChange={(e) => {
                setUsername(e.target.value);
                setError("");
              }}
            />
          </div>
          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400">
              <Lock className="w-5 h-5" aria-hidden />
            </span>
            <input
              placeholder="Password"
              type={showPassword ? "text" : "password"}
              name="password"
              autoComplete="current-password"
              aria-label="Password"
              value={password}
              className="w-full pl-12 pr-12 py-3.5 min-h-12 rounded-2xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-200 bg-gray-50 text-black text-base"
              onChange={(e) => {
                setPassword(e.target.value);
                setError("");
              }}
            />
            <button
              type="button"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 cursor-pointer w-10 h-10 flex items-center justify-center"
              aria-label={showPassword ? "Hide password" : "Show password"}
              onClick={() => setShowPassword((v) => !v)}
            >
              {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            </button>
          </div>
          {error ? <p className="text-base text-red-500 text-left">{error}</p> : null}
        </div>
        <button
          type="submit"
          disabled={busy}
          className="w-full font-medium py-3.5 min-h-12 rounded-2xl shadow hover:brightness-105 cursor-pointer transition mb-5 mt-3 text-base disabled:opacity-60 disabled:cursor-default"
          style={{ background: "linear-gradient(to bottom, #374151, #111827)", color: "#fff" }}
        >
          {busy ? "Signing in…" : "Get Started"}
        </button>
        <div className="flex items-center w-full my-3">
          <div className="flex-grow border-t border-dashed border-gray-200" />
          <span className="mx-3 text-sm text-gray-400">Demo accounts</span>
          <div className="flex-grow border-t border-dashed border-gray-200" />
        </div>
        <div className="flex gap-3 w-full flex-wrap justify-center mt-2">
          {PRIMARY.map((a) => (
            <button
              key={a.username}
              type="button"
              className="flex items-center justify-center min-h-12 px-5 rounded-2xl border border-gray-200 bg-white hover:bg-gray-100 transition text-sm font-medium text-gray-700"
              onClick={() => {
                fillAccount(a.username, a.password);
                setMorePick("");
              }}
            >
              {a.name.split(" ")[0]}
            </button>
          ))}
        </div>
        <div className="relative w-full mt-4">
          <select
            aria-label="More demo accounts"
            value={morePick}
            className="w-full appearance-none min-h-12 pl-4 pr-12 py-3 rounded-2xl border border-gray-200 bg-white text-base text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-200 cursor-pointer"
            onChange={(e) => {
              const id = e.target.value;
              setMorePick(id);
              const account = MORE.find((a) => a.username === id);
              if (account) fillAccount(account.username, account.password);
            }}
          >
            <option value="">More accounts…</option>
            {MORE.map((a) => (
              <option key={a.username} value={a.username}>
                {a.name} · {a.username}/{a.password} · {a.title}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" aria-hidden />
        </div>
        <p className="text-sm text-gray-400 mt-4 text-center leading-snug">
          ava/planner · rico/yard · mina/floor · drivers use drive
        </p>
      </form>
    </div>
  );
}
