use super::*;
use crate::cloud::grants;
use chrono::{Duration, Utc};
use secrets::{
    clear_installation_login, connection, datasource_login, installation_login,
    store_installation_login, validate_login_user, Login, SecretError,
};

fn runtime_ds(installation: Option<&str>) -> DatasourceConfig {
    let id = uuid::Uuid::new_v4().to_string();
    DatasourceConfig {
        kind: "postgres".into(),
        id: id.clone(),
        host: "db.example.com".into(),
        database: "app".into(),
        user: "app_owner".into(),
        password_ref: Some(secrets::datasource_secret_id(&id)),
        installation: installation.map(str::to_string),
        ..Default::default()
    }
}

#[test]
fn auth_failures_are_told_apart_from_unreachable_servers() {
    for refused in [
        "PostgreSQL connection failed: FATAL:  password authentication failed for user \"bob\"",
        "connection failed: fe_sendauth: no password supplied",
        "FATAL: role \"bob\" does not exist",
        "FATAL: no pg_hba.conf entry for host",
    ] {
        assert!(is_auth_failure(refused), "{refused}");
    }
    for other in [
        "could not translate host name \"db\" to address",
        "Connection refused",
        "timeout expired",
    ] {
        assert!(!is_auth_failure(other), "{other}");
    }
}

#[test]
fn login_usernames_are_validated() {
    assert!(validate_login_user("alice").is_ok());
    assert!(validate_login_user("app.reader@corp").is_ok());
    for bad in ["", "   ", "a\nb", "nul\0", &"x".repeat(64)] {
        assert_eq!(validate_login_user(bad).unwrap_err().code, "VALIDATION");
    }
}

#[test]
fn a_runtime_login_is_sealed_per_installation_and_replaces_the_bundled_user() {
    let ds = runtime_ds(Some(&format!("bundle-{}", uuid::Uuid::new_v4())));
    // Nothing stored on the recipient's machine: Runtime must ask.
    let login = datasource_login(&ds).unwrap();
    assert_eq!(login.source, LoginSource::None);
    assert_eq!(login.password, None);

    // sslmode require does not verify the server: the recipient must accept.
    assert_eq!(
        store_installation_login(&ds, "alice", "alice-s3cret!", false)
            .unwrap_err()
            .code,
        "UNVERIFIED_TRANSPORT"
    );
    assert_eq!(datasource_login(&ds).unwrap().source, LoginSource::None);
    store_installation_login(&ds, "alice", "alice-s3cret!", true).unwrap();
    let login = datasource_login(&ds).unwrap();
    assert_eq!(login.source, LoginSource::Installation);
    assert_eq!(login.user, "alice");
    assert_eq!(login.password.as_deref(), Some("alice-s3cret!"));
    let (connect_as, password) = connection(&ds).unwrap();
    assert_eq!(connect_as.user, "alice");
    assert_eq!(connect_as.host, ds.host);
    assert_eq!(password.as_deref(), Some("alice-s3cret!"));

    // Sealed at rest: the secret store file never holds the plaintext.
    let raw = std::fs::read_to_string(
        crate::paths::state_dir()
            .join("data")
            .join("secrets")
            .join("secrets.json"),
    )
    .unwrap();
    assert!(!raw.contains("alice-s3cret!"));
    assert!(!raw.contains("\"alice\""));

    // Another installation of the same datasource, and Studio, do not see it.
    let mut other = ds.clone();
    other.installation = Some("another-bundle".into());
    assert_eq!(installation_login(&other).unwrap(), None);
    let mut studio = ds.clone();
    studio.installation = None;
    assert_eq!(datasource_login(&studio).unwrap().source, LoginSource::None);

    // An update that moves the datasource to another server asks again.
    let mut moved = ds.clone();
    moved.host = "new-db.example.com".into();
    assert_eq!(datasource_login(&moved).unwrap().source, LoginSource::None);

    clear_installation_login(&ds).unwrap();
    assert_eq!(datasource_login(&ds).unwrap().source, LoginSource::None);
}

#[test]
fn runtime_logins_need_an_installation_and_a_confirmed_transport() {
    let studio = runtime_ds(None);
    assert_eq!(
        store_installation_login(&studio, "alice", "pw", true)
            .unwrap_err()
            .code,
        "NOT_RUNTIME"
    );
    let mut ds = runtime_ds(Some("bundle-tls"));
    store_installation_login(&ds, "alice", "pw", true).unwrap();
    ds.sslmode = "disable".into();
    assert_eq!(
        datasource_login(&ds).unwrap_err().code,
        "INSECURE_TRANSPORT"
    );
    ds.sslmode = "require".into();
    clear_installation_login(&ds).unwrap();
}

#[test]
fn a_runtime_login_is_bound_to_the_transport_it_was_entered_for() {
    let mut ds = runtime_ds(Some(&format!("bundle-{}", uuid::Uuid::new_v4())));
    ds.sslmode = "verify-full".into();
    // verify-full checks the server: no acceptance needed.
    store_installation_login(&ds, "alice", "pw", false).unwrap();
    assert_eq!(
        datasource_login(&ds).unwrap().source,
        LoginSource::Installation
    );
    // An update that downgrades the transport reads the login as none.
    for downgraded in [
        DatasourceConfig {
            sslmode: "require".into(),
            ..ds.clone()
        },
        DatasourceConfig {
            sslmode: "verify-ca".into(),
            ..ds.clone()
        },
        DatasourceConfig {
            sslmode: "disable".into(),
            insecure_transport_confirmed: true,
            ..ds.clone()
        },
    ] {
        assert_eq!(
            installation_login(&downgraded).unwrap(),
            None,
            "{}",
            downgraded.sslmode
        );
        let login = datasource_login(&downgraded).unwrap();
        assert_eq!(login.source, LoginSource::None, "Runtime asks again");
        assert_eq!(login.password, None);
    }
    // A plaintext bundle confirmed by its author still needs the recipient.
    let mut plain = ds.clone();
    plain.sslmode = "disable".into();
    plain.insecure_transport_confirmed = true;
    assert_eq!(
        store_installation_login(&plain, "alice", "pw", false)
            .unwrap_err()
            .code,
        "UNVERIFIED_TRANSPORT"
    );
    plain.insecure_transport_confirmed = false;
    assert_eq!(
        store_installation_login(&plain, "alice", "pw", true)
            .unwrap_err()
            .code,
        "INSECURE_TRANSPORT"
    );
    clear_installation_login(&ds).unwrap();
}

#[test]
fn a_manual_installation_never_uses_a_cloud_grant() {
    let mut ds = runtime_ds(Some(&format!("bundle-{}", uuid::Uuid::new_v4())));
    store_installation_login(&ds, "local_user", "local-pw", true).unwrap();
    let manual = ds.clone();
    let target = secrets::datasource_target(&ds);
    grants::put(
        "cloud-window",
        &target,
        Some("bob".into()),
        "bob-pw".into(),
        Utc::now() + Duration::hours(1),
    );
    let login = datasource_login(&ds).unwrap();
    assert_eq!(login.source, LoginSource::Installation);
    assert_eq!(login.user, "local_user");
    // The cloud session holding the grant ignores the manual install's login.
    ds.installation = None;
    ds.grant_scope = Some("cloud-window".into());
    let login = datasource_login(&ds).unwrap();
    assert_eq!(login.source, LoginSource::Grant);
    assert_eq!(login.user, "bob");
    assert_eq!(connection(&ds).unwrap().0.user, "bob");
    // A shared grant keeps the configured user.
    grants::put(
        "cloud-window",
        &target,
        None,
        "shared-pw".into(),
        Utc::now() + Duration::hours(1),
    );
    assert_eq!(datasource_login(&ds).unwrap().user, "app_owner");
    grants::clear("cloud-window", &target);
    clear_installation_login(&manual).unwrap();
}

#[test]
fn status_reasons_tell_missing_rejected_and_lookup_errors_apart() {
    let source = |r: &Result<Login, SecretError>| match r {
        Ok(l) if l.password.is_some() => l.source,
        _ => LoginSource::None,
    };
    let stored: Result<Login, SecretError> = Ok(Login {
        user: "alice".into(),
        password: Some("pw".into()),
        source: LoginSource::Installation,
    });
    let none: Result<Login, SecretError> = Ok(Login {
        user: "app".into(),
        password: None,
        source: LoginSource::None,
    });
    let failed: Result<Login, SecretError> = Err(SecretError {
        code: "INSECURE_TRANSPORT",
        message: "sslmode disable".into(),
    });
    let refused = Some("FATAL: password authentication failed for user \"alice\"");
    let reason = |attached, r: &Result<Login, SecretError>, error| {
        login_reason(attached, r.is_err(), source(r), error)
    };
    assert_eq!(reason(false, &none, None), Some("missing"));
    assert_eq!(reason(false, &none, refused), Some("missing"));
    assert_eq!(reason(false, &stored, refused), Some("rejected"));
    // Unreachable server with a stored login: report, do not ask again.
    assert_eq!(reason(false, &stored, Some("Connection refused")), None);
    // A lookup error is reported, never asked for.
    assert_eq!(reason(false, &failed, None), None);
    assert_eq!(reason(false, &failed, refused), None);
    // Connected: nothing to ask.
    assert_eq!(reason(true, &none, None), None);
    assert_eq!(reason(true, &stored, refused), None);
}

/// Against a real server (`IXTABLE_TEST_POSTGRES_URL`): a wrong password maps
/// to AUTH_FAILED without echoing it, and a stored login connects.
#[test]
fn postgres_refuses_a_wrong_login_with_auth_failed() {
    let Ok(url) = std::env::var("IXTABLE_TEST_POSTGRES_URL") else {
        eprintln!("skipping: set IXTABLE_TEST_POSTGRES_URL");
        return;
    };
    let cfg: postgres::Config = url.parse().unwrap();
    let host = match &cfg.get_hosts()[0] {
        postgres::config::Host::Tcp(h) => h.clone(),
        #[cfg(unix)]
        _ => "localhost".into(),
    };
    let password = String::from_utf8(cfg.get_password().unwrap().to_vec()).unwrap();
    let mut ds = runtime_ds(Some(&format!("bundle-{}", uuid::Uuid::new_v4())));
    ds.host = host;
    ds.port = cfg.get_ports().first().copied().unwrap_or(5432);
    ds.database = cfg.get_dbname().unwrap().into();
    ds.sslmode = "disable".into();
    ds.insecure_transport_confirmed = true;
    let user = cfg.get_user().unwrap().to_string();
    let mut wrong = ds.clone();
    wrong.user = user.clone();
    let e = crate::postgres::probe(&wrong, Some("not-the-password-123")).unwrap_err();
    assert_eq!(e.code, "AUTH_FAILED");
    assert!(!e.message.contains("not-the-password-123"));
    assert!(is_auth_failure(&e.message));

    // The DuckDB reader's attach error for a refused login reads as one.
    let workspace = std::env::temp_dir().join(format!("ixtable-login-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&workspace).unwrap();
    let mut reader =
        crate::data::ReadRuntime::new(&workspace, &crate::data::sqlite_extension_path().unwrap())
            .unwrap();
    let attach = reader.set_target(ReadTarget::Postgres {
        conninfo: crate::postgres::conninfo(&wrong, Some("not-the-password-123")),
        schema: "public".into(),
    });
    let message = attach.unwrap_err();
    assert!(is_auth_failure(&message), "{message}");
    assert!(!message.contains("not-the-password-123"), "{message}");

    store_installation_login(&ds, &user, &password, true).unwrap();
    let (connect_as, pw) = connection(&ds).unwrap();
    assert!(crate::postgres::probe(&connect_as, pw.as_deref()).is_ok());
    drop(reader);
    let _ = std::fs::remove_dir_all(workspace);
    clear_installation_login(&ds).unwrap();
}
