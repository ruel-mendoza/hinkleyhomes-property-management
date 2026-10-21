import { useState, type ReactNode } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  ArrowRight,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronLeft,
  House,
  LoaderCircle,
  LockKeyhole,
  Mail,
  ShieldCheck,
} from "lucide-react";
import { useSignIn, useSignUp } from "@clerk/react";
import { Link, useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { useValidateSignupEmail } from "@workspace/api-client-react";
import { isAllowedStaffEmail } from "@/lib/staff-email";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import "./auth.css";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const restrictedEmailMessage =
  "Access restricted: Only @hinkleyhomes.co.uk email addresses are allowed to register.";

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

function Brand() {
  return (
    <Link href="/" className="auth-brand" data-testid="link-auth-brand">
      <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="" />
      <span>
        <strong>Hinkley Homes</strong>
        <small>Property operations</small>
      </span>
    </Link>
  );
}

function AuthLayout({
  children,
  page,
}: {
  children: ReactNode;
  page: "welcome" | "login" | "signup";
}) {
  return (
    <div className={`auth-layout auth-layout-${page}`}>
      <section className="auth-story" aria-label="Hinkley Homes staff portal">
        <Brand />
        <div className="auth-story-content">
          <div className="auth-story-kicker">
            <span className="auth-kicker-dot" />
            STAFF PROPERTY OPERATIONS
          </div>
          <h1>Make every property day run smoothly.</h1>
          <p>
            A single, secure workspace for tenancies, maintenance, property activity, and
            the teams who keep Hinkley Homes moving.
          </p>
          <div className="auth-story-card">
            <div className="auth-story-card-icon">
              <CalendarDays size={17} />
            </div>
            <div>
              <strong>One clear view of the day</strong>
              <span>Bookings, arrivals, and property activity together.</span>
            </div>
            <CheckCircle2 size={17} className="auth-story-check" />
          </div>
        </div>
        <div className="auth-story-footer">
          <ShieldCheck size={14} />
          Restricted to Hinkley Homes staff
        </div>
      </section>
      <main className="auth-main">
        <div className="auth-mobile-brand"><Brand /></div>
        <div className="auth-panel">{children}</div>
        <div className="auth-main-footer">Hinkley Homes · Staff portal</div>
      </main>
    </div>
  );
}

function AuthHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="auth-heading">
      <span className="auth-eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  );
}

function AuthError({ children }: { children: string }) {
  return (
    <div className="auth-error" role="alert" data-testid="auth-error">
      <span aria-hidden="true">!</span>
      {children}
    </div>
  );
}

function AuthSubmit({
  busy,
  children,
  testId,
}: {
  busy: boolean;
  children: ReactNode;
  testId: string;
}) {
  return (
    <button
      className="auth-submit"
      type="submit"
      disabled={busy}
      data-testid={testId}
    >
      {busy ? <LoaderCircle size={16} className="auth-spinner" /> : children}
    </button>
  );
}

export function AuthLandingPage() {
  return (
    <AuthLayout page="welcome">
      <div className="auth-welcome-mark"><House size={19} /></div>
      <AuthHeading
        eyebrow="WELCOME TO YOUR WORKSPACE"
        title="Hinkley Homes PMS"
        description="Sign in to manage your property operations, or create a staff account using your company email."
      />
      <div className="auth-welcome-actions">
        <Link
          className="auth-submit"
          href="/sign-in"
          data-testid="link-sign-in"
        >
          Sign in <ArrowRight size={16} />
        </Link>
        <Link
          className="auth-secondary"
          href="/sign-up"
          data-testid="link-sign-up"
        >
          Create a staff account
        </Link>
      </div>
      <div className="auth-restriction-note">
        <LockKeyhole size={14} />
        Registration is limited to @hinkleyhomes.co.uk addresses.
      </div>
    </AuthLayout>
  );
}

const signInSchema = z.object({
  email: z.string().trim().email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
});
type SignInValues = z.infer<typeof signInSchema>;

const signUpSchema = z
  .object({
    fullName: z.string().trim().min(2, "Enter your full name."),
    email: z
      .string()
      .trim()
      .email("Enter a valid email address.")
      .refine(isAllowedStaffEmail, restrictedEmailMessage),
    password: z.string().min(10, "Use at least 10 characters."),
    confirmPassword: z.string().min(1, "Confirm your password."),
  })
  .refine((values) => values.password === values.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords do not match.",
  });
type SignUpValues = z.infer<typeof signUpSchema>;

const codeSchema = z.object({
  code: z.string().trim().min(4, "Enter the verification code."),
});
type CodeValues = z.infer<typeof codeSchema>;

export function SignInPage() {
  const { signIn, fetchStatus } = useSignIn();
  const [, setLocation] = useLocation();
  const [authError, setAuthError] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);
  const form = useForm<SignInValues>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: "", password: "" },
  });
  const codeForm = useForm<CodeValues>({
    resolver: zodResolver(codeSchema),
    defaultValues: { code: "" },
  });
  const busy = fetchStatus === "fetching";

  const navigateToDashboard = ({
    decorateUrl,
  }: {
    decorateUrl: (url: string) => string;
  }) => {
    const target = decorateUrl(`${basePath}/dashboard`);
    if (target.startsWith("http")) {
      window.location.href = target;
    } else {
      setLocation(stripBase(target));
    }
  };

  const finishSignIn = async () => {
    const { error } = await signIn.finalize({ navigate: navigateToDashboard });
    if (error) setAuthError(error.message || "Could not finish signing in.");
  };

  const submitCredentials = async (values: SignInValues) => {
    setAuthError("");
    const { error } = await signIn.password({
      emailAddress: values.email.trim(),
      password: values.password,
    });
    if (error) {
      setAuthError(error.message || "Check your email and password and try again.");
      return;
    }

    if (signIn.status === "complete") {
      await finishSignIn();
      return;
    }

    if (
      signIn.status === "needs_second_factor" ||
      signIn.status === "needs_client_trust"
    ) {
      const emailCodeAvailable = signIn.supportedSecondFactors?.some(
        (factor) => factor.strategy === "email_code",
      );
      if (emailCodeAvailable) {
        const result = await signIn.mfa.sendEmailCode();
        if (result.error) {
          setAuthError(result.error.message || "Could not send a verification code.");
        } else {
          setIsVerifying(true);
        }
        return;
      }
    }

    setAuthError("This account needs an additional sign-in step. Contact your administrator.");
  };

  const submitCode = async (values: CodeValues) => {
    setAuthError("");
    const { error } = await signIn.mfa.verifyEmailCode({ code: values.code.trim() });
    if (error) {
      setAuthError(error.message || "That verification code could not be confirmed.");
      return;
    }
    if (signIn.status === "complete") await finishSignIn();
  };

  return (
    <AuthLayout page="login">
      <Link className="auth-back-link" href="/" data-testid="link-auth-home">
        <ChevronLeft size={15} /> Home
      </Link>
      <AuthHeading
        eyebrow="STAFF ACCESS"
        title={isVerifying ? "Verify your sign-in" : "Welcome back"}
        description={
          isVerifying
            ? "Enter the code sent to your email to finish signing in."
            : "Sign in with your Hinkley Homes staff account."
        }
      />
      {authError && <AuthError>{authError}</AuthError>}

      {isVerifying ? (
        <Form {...codeForm}>
          <form
            className="auth-form"
            onSubmit={codeForm.handleSubmit(submitCode)}
            noValidate
          >
            <FormField
              control={codeForm.control}
              name="code"
              render={({ field }) => (
                <FormItem className="auth-field">
                  <FormLabel className="auth-label">Verification code</FormLabel>
                  <FormControl>
                    <input
                      {...field}
                      className="auth-input"
                      autoComplete="one-time-code"
                      inputMode="numeric"
                      placeholder="Enter your code"
                      data-testid="input-signin-code"
                    />
                  </FormControl>
                  <FormMessage className="auth-field-error" />
                </FormItem>
              )}
            />
            <AuthSubmit busy={busy} testId="button-verify-signin">
              Verify and continue <ArrowRight size={16} />
            </AuthSubmit>
            <button
              type="button"
              className="auth-text-button"
              onClick={() => {
                setIsVerifying(false);
                setAuthError("");
              }}
              data-testid="button-back-to-signin"
            >
              Use a different sign-in
            </button>
          </form>
        </Form>
      ) : (
        <Form {...form}>
          <form
            className="auth-form"
            onSubmit={form.handleSubmit(submitCredentials)}
            noValidate
          >
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem className="auth-field">
                  <FormLabel className="auth-label">Email address</FormLabel>
                  <FormControl>
                    <input
                      {...field}
                      className="auth-input"
                      type="email"
                      autoComplete="username"
                      autoCapitalize="none"
                      placeholder="name@hinkleyhomes.co.uk"
                      data-testid="input-signin-email"
                    />
                  </FormControl>
                  <FormMessage className="auth-field-error" />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem className="auth-field">
                  <FormLabel className="auth-label">Password</FormLabel>
                  <FormControl>
                    <input
                      {...field}
                      className="auth-input"
                      type="password"
                      autoComplete="current-password"
                      placeholder="Enter your password"
                      data-testid="input-signin-password"
                    />
                  </FormControl>
                  <FormMessage className="auth-field-error" />
                </FormItem>
              )}
            />
            <AuthSubmit busy={busy} testId="button-signin">
              Sign in <ArrowRight size={16} />
            </AuthSubmit>
          </form>
        </Form>
      )}

      <div className="auth-switch">
        New to the staff portal?{" "}
        <Link href="/sign-up" data-testid="link-signup-from-signin">
          Create an account
        </Link>
      </div>
      <div className="auth-security-foot">
        <LockKeyhole size={13} /> Secure staff access
      </div>
    </AuthLayout>
  );
}

export function SignUpPage() {
  const { signUp, fetchStatus } = useSignUp();
  const [, setLocation] = useLocation();
  const [authError, setAuthError] = useState("");
  const [stage, setStage] = useState<"details" | "verify">("details");
  const [signupEmail, setSignupEmail] = useState("");
  const validateEmail = useValidateSignupEmail();
  const form = useForm<SignUpValues>({
    resolver: zodResolver(signUpSchema),
    mode: "onSubmit",
    reValidateMode: "onChange",
    defaultValues: {
      fullName: "",
      email: "",
      password: "",
      confirmPassword: "",
    },
  });
  const codeForm = useForm<CodeValues>({
    resolver: zodResolver(codeSchema),
    defaultValues: { code: "" },
  });
  const busy = fetchStatus === "fetching" || validateEmail.isPending;

  const navigateToDashboard = ({
    decorateUrl,
  }: {
    decorateUrl: (url: string) => string;
  }) => {
    const target = decorateUrl(`${basePath}/dashboard`);
    if (target.startsWith("http")) {
      window.location.href = target;
    } else {
      setLocation(stripBase(target));
    }
  };

  const submitDetails = async (values: SignUpValues) => {
    setAuthError("");
    const email = values.email.trim();

    if (!isAllowedStaffEmail(email)) {
      form.setError("email", {
        type: "validate",
        message: restrictedEmailMessage,
      });
      return;
    }

    try {
      const domainCheck = await validateEmail.mutateAsync({
        data: { email },
      });
      if (!domainCheck.allowed) {
        form.setError("email", {
          type: "server",
          message: domainCheck.message || restrictedEmailMessage,
        });
        return;
      }
    } catch (error) {
      setAuthError(
        errorMessage(error, "We could not verify this email. Please try again."),
      );
      return;
    }

    const { error } = await signUp.password({
      emailAddress: email,
      password: values.password,
      unsafeMetadata: { fullName: values.fullName.trim() },
    });

    if (error) {
      setAuthError(error.message || "Could not create your account.");
      return;
    }

    setSignupEmail(email);
    setStage("verify");
    const sendResult = await signUp.verifications.sendEmailCode();
    if (sendResult.error) {
      setAuthError(
        sendResult.error.message || "Could not send the verification code.",
      );
    }
  };

  const submitCode = async (values: CodeValues) => {
    setAuthError("");
    const { error } = await signUp.verifications.verifyEmailCode({
      code: values.code.trim(),
    });
    if (error) {
      setAuthError(error.message || "That verification code could not be confirmed.");
      return;
    }
    if (signUp.status !== "complete") {
      setAuthError("Your account is not ready yet. Request a new code and try again.");
      return;
    }
    const { error: finalizeError } = await signUp.finalize({
      navigate: navigateToDashboard,
    });
    if (finalizeError) {
      setAuthError(finalizeError.message || "Could not finish creating your account.");
    }
  };

  const resendCode = async () => {
    setAuthError("");
    const { error } = await signUp.verifications.sendEmailCode();
    if (error) setAuthError(error.message || "Could not resend the code.");
  };

  return (
    <AuthLayout page="signup">
      <Link className="auth-back-link" href="/" data-testid="link-auth-home">
        <ChevronLeft size={15} /> Home
      </Link>
      <AuthHeading
        eyebrow="HINKLEY HOMES STAFF"
        title={stage === "verify" ? "Check your email" : "Create your account"}
        description={
          stage === "verify"
            ? `We sent a verification code to ${signupEmail}.`
            : "Use your company email to set up secure access to the staff portal."
        }
      />
      {authError && <AuthError>{authError}</AuthError>}

      {stage === "verify" ? (
        <Form {...codeForm}>
          <form
            className="auth-form"
            onSubmit={codeForm.handleSubmit(submitCode)}
            noValidate
          >
            <FormField
              control={codeForm.control}
              name="code"
              render={({ field }) => (
                <FormItem className="auth-field">
                  <FormLabel className="auth-label">Verification code</FormLabel>
                  <FormControl>
                    <input
                      {...field}
                      className="auth-input auth-code-input"
                      autoComplete="one-time-code"
                      inputMode="numeric"
                      placeholder="Enter the code from your email"
                      data-testid="input-signup-code"
                    />
                  </FormControl>
                  <FormMessage className="auth-field-error" />
                </FormItem>
              )}
            />
            <AuthSubmit busy={busy} testId="button-verify-signup">
              Verify email <Check size={16} />
            </AuthSubmit>
            <button
              type="button"
              className="auth-text-button"
              onClick={resendCode}
              disabled={busy}
              data-testid="button-resend-signup-code"
            >
              Send a new code
            </button>
          </form>
        </Form>
      ) : (
        <Form {...form}>
          <form
            className="auth-form"
            onSubmit={form.handleSubmit(submitDetails)}
            noValidate
          >
            <FormField
              control={form.control}
              name="fullName"
              render={({ field }) => (
                <FormItem className="auth-field">
                  <FormLabel className="auth-label">Full name</FormLabel>
                  <FormControl>
                    <input
                      {...field}
                      className="auth-input"
                      autoComplete="name"
                      placeholder="Your full name"
                      data-testid="input-signup-full-name"
                    />
                  </FormControl>
                  <FormMessage className="auth-field-error" />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem className="auth-field">
                  <FormLabel className="auth-label">Company email</FormLabel>
                  <FormControl>
                    <input
                      {...field}
                      className="auth-input"
                      type="email"
                      autoComplete="email"
                      autoCapitalize="none"
                      placeholder="name@hinkleyhomes.co.uk"
                      data-testid="input-signup-email"
                      onChange={(event) => {
                        field.onChange(event);
                        if (form.formState.errors.email) form.clearErrors("email");
                      }}
                    />
                  </FormControl>
                  <FormMessage className="auth-field-error" />
                </FormItem>
              )}
            />
            <div className="auth-field-pair">
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem className="auth-field">
                    <FormLabel className="auth-label">Password</FormLabel>
                    <FormControl>
                      <input
                        {...field}
                        className="auth-input"
                        type="password"
                        autoComplete="new-password"
                        minLength={10}
                        placeholder="At least 10 characters"
                        data-testid="input-signup-password"
                      />
                    </FormControl>
                    <FormMessage className="auth-field-error" />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="confirmPassword"
                render={({ field }) => (
                  <FormItem className="auth-field">
                    <FormLabel className="auth-label">Confirm password</FormLabel>
                    <FormControl>
                      <input
                        {...field}
                        className="auth-input"
                        type="password"
                        autoComplete="new-password"
                        placeholder="Re-enter password"
                        data-testid="input-signup-confirm-password"
                      />
                    </FormControl>
                    <FormMessage className="auth-field-error" />
                  </FormItem>
                )}
              />
            </div>
            <div id="clerk-captcha" data-testid="signup-captcha-slot" />
            <AuthSubmit busy={busy} testId="button-signup">
              Create account <ArrowRight size={16} />
            </AuthSubmit>
            <p className="auth-password-note">
              Passwords must be at least 10 characters. Your password is secured
              by Clerk and is never stored by this app.
            </p>
          </form>
        </Form>
      )}

      <div className="auth-switch">
        Already have an account?{" "}
        <Link href="/sign-in" data-testid="link-signin-from-signup">
          Sign in
        </Link>
      </div>
      <div className="auth-security-foot">
        <Mail size={13} /> Company email verification is required
      </div>
    </AuthLayout>
  );
}

export function AccessRestrictedPage({
  onSignOut,
}: {
  onSignOut: () => void;
}) {
  return (
    <AuthLayout page="login">
      <div className="auth-welcome-mark"><LockKeyhole size={18} /></div>
      <AuthHeading
        eyebrow="ACCESS RESTRICTED"
        title="This staff portal is private"
        description={restrictedEmailMessage}
      />
      <button
        className="auth-submit"
        type="button"
        onClick={onSignOut}
        data-testid="button-restricted-signout"
      >
        Sign out <ArrowRight size={16} />
      </button>
    </AuthLayout>
  );
}

export function AuthLoadingPage() {
  return (
    <div className="auth-loading" role="status" data-testid="auth-loading">
      <LoaderCircle size={22} className="auth-spinner" />
      <span>Loading your secure workspace…</span>
    </div>
  );
}

