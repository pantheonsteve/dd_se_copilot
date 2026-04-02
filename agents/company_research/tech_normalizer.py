"""Technology name normalization, categorization, and dependency mapping.

Provides a single canonical vocabulary so Sumble and BuiltWith data can be
compared directly.  Every raw technology name — regardless of source — passes
through ``normalize_tech_name`` before entering the confidence engine.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Alias mapping: raw name (any casing) -> canonical display name
# ---------------------------------------------------------------------------

TECH_NAME_ALIASES: dict[str, str] = {
    # --- Cloud providers ---
    "Amazon Web Services": "AWS",
    "amazon-web-services": "AWS",
    "aws": "AWS",
    "Google Cloud Platform": "GCP",
    "google-cloud-platform": "GCP",
    "gcp": "GCP",
    "google cloud": "GCP",
    "Microsoft Azure": "Azure",
    "microsoft-azure": "Azure",
    "azure": "Azure",

    # --- Observability / APM ---
    "Datadog": "Datadog",
    "datadog": "Datadog",
    "New Relic": "New Relic",
    "new-relic": "New Relic",
    "newrelic": "New Relic",
    "Dynatrace": "Dynatrace",
    "dynatrace": "Dynatrace",
    "AppDynamics": "AppDynamics",
    "appdynamics": "AppDynamics",
    "app dynamics": "AppDynamics",
    "cisco app dynamics": "AppDynamics",
    "cisco-app-dynamics": "AppDynamics",
    "Splunk": "Splunk",
    "splunk": "Splunk",
    "Elastic": "ELK",
    "elastic": "ELK",
    "Elasticsearch": "ELK",
    "elasticsearch": "ELK",
    "elk": "ELK",
    "Kibana": "ELK",
    "kibana": "ELK",
    "Logstash": "ELK",
    "logstash": "ELK",
    "Grafana": "Grafana",
    "grafana": "Grafana",
    "Prometheus": "Prometheus",
    "prometheus": "Prometheus",
    "Nagios": "Nagios",
    "nagios": "Nagios",
    "Zabbix": "Zabbix",
    "zabbix": "Zabbix",
    "Sumo Logic": "Sumo Logic",
    "sumo-logic": "Sumo Logic",
    "sumologic": "Sumo Logic",
    "PagerDuty": "PagerDuty",
    "pagerduty": "PagerDuty",
    "OpsGenie": "OpsGenie",
    "opsgenie": "OpsGenie",
    "Amazon CloudWatch": "CloudWatch",
    "aws cloudwatch": "CloudWatch",
    "aws-cloudwatch": "CloudWatch",
    "cloudwatch": "CloudWatch",
    "Azure Monitor": "Azure Monitor",
    "azure-monitor": "Azure Monitor",
    "GCP Cloud Monitoring": "GCP Cloud Monitoring",
    "gcp-cloud-monitoring": "GCP Cloud Monitoring",
    "google cloud monitoring": "GCP Cloud Monitoring",
    "Stackdriver": "GCP Cloud Monitoring",
    "stackdriver": "GCP Cloud Monitoring",
    "SignalFx": "SignalFx",
    "signalfx": "SignalFx",
    "signalfx-microservices-apm": "SignalFx",
    "Honeycomb": "Honeycomb",
    "honeycomb": "Honeycomb",
    "Lightstep": "Lightstep",
    "lightstep": "Lightstep",
    "Sentry": "Sentry",
    "sentry": "Sentry",
    "Instana": "Instana",
    "instana": "Instana",
    "IBM Instana": "Instana",
    "ibm-instana": "Instana",
    "ibm instana": "Instana",
    "Catchpoint": "Catchpoint",
    "catchpoint": "Catchpoint",
    "ThousandEyes": "ThousandEyes",
    "thousandeyes": "ThousandEyes",
    "OpenTelemetry": "OpenTelemetry",
    "opentelemetry": "OpenTelemetry",
    "otel open-telemetry": "OpenTelemetry",
    "otel-open-telemetry": "OpenTelemetry",
    "Site24x7": "Site24x7",
    "site24x7": "Site24x7",
    "Pingdom": "Pingdom",
    "pingdom": "Pingdom",
    "ManageEngine": "ManageEngine",
    "manageengine": "ManageEngine",
    "SolarWinds": "SolarWinds",
    "solarwinds": "SolarWinds",
    "solarwinds orion": "SolarWinds",
    "solarwinds npm": "SolarWinds",
    "LogicMonitor": "LogicMonitor",
    "logicmonitor": "LogicMonitor",
    "Icinga": "Icinga",
    "icinga": "Icinga",
    "VictorOps": "VictorOps",
    "victorops": "VictorOps",

    # --- Infrastructure ---
    "Docker": "Docker",
    "docker": "Docker",
    "Kubernetes": "Kubernetes",
    "kubernetes": "Kubernetes",
    "k8s": "Kubernetes",
    "Terraform": "Terraform",
    "terraform": "Terraform",
    "Ansible": "Ansible",
    "ansible": "Ansible",
    "Jenkins": "Jenkins",
    "jenkins": "Jenkins",
    "Helm": "Helm",
    "helm": "Helm",
    "Istio": "Istio",
    "istio": "Istio",
    "Consul": "Consul",
    "consul": "Consul",
    "Vault": "Vault",
    "vault": "Vault",
    "Nomad": "Nomad",
    "nomad": "Nomad",
    "Puppet": "Puppet",
    "puppet": "Puppet",
    "Chef": "Chef",
    "chef": "Chef",
    "Salt": "Salt",
    "salt": "Salt",
    "Flux": "Flux",
    "flux": "Flux",

    # --- CI/CD ---
    "CircleCI": "CircleCI",
    "circleci": "CircleCI",
    "GitHub Actions": "GitHub Actions",
    "github-actions": "GitHub Actions",
    "github actions": "GitHub Actions",
    "GitLab": "GitLab",
    "gitlab": "GitLab",
    "ArgoCD": "ArgoCD",
    "argocd": "ArgoCD",
    "argo cd": "ArgoCD",
    "Artifactory": "Artifactory",
    "artifactory": "Artifactory",
    "Spinnaker": "Spinnaker",
    "spinnaker": "Spinnaker",
    "Harness": "Harness",
    "harness": "Harness",

    # --- Databases ---
    "PostgreSQL": "PostgreSQL",
    "postgresql": "PostgreSQL",
    "postgres": "PostgreSQL",
    "MySQL": "MySQL",
    "mysql": "MySQL",
    "MongoDB": "MongoDB",
    "mongodb": "MongoDB",
    "mongo": "MongoDB",
    "Redis": "Redis",
    "redis": "Redis",
    "Microsoft SQL Server": "SQL Server",
    "sql server": "SQL Server",
    "mssql": "SQL Server",
    "Oracle Database": "Oracle DB",
    "oracle database": "Oracle DB",
    "oracle db": "Oracle DB",
    "IBM DB2": "DB2",
    "ibm db2": "DB2",
    "db2": "DB2",
    "Cassandra": "Cassandra",
    "cassandra": "Cassandra",
    "CouchDB": "CouchDB",
    "couchdb": "CouchDB",
    "Couchbase": "Couchbase",
    "couchbase": "Couchbase",
    "MariaDB": "MariaDB",
    "mariadb": "MariaDB",
    "DynamoDB": "DynamoDB",
    "dynamodb": "DynamoDB",
    "CosmosDB": "CosmosDB",
    "cosmosdb": "CosmosDB",
    "cosmos db": "CosmosDB",

    # --- Message Queues / Streaming ---
    "Apache Kafka": "Kafka",
    "apache-kafka": "Kafka",
    "kafka": "Kafka",
    "Kafka Connect": "Kafka Connect",
    "kafka-connect": "Kafka Connect",
    "RabbitMQ": "RabbitMQ",
    "rabbitmq": "RabbitMQ",
    "rabbit mq": "RabbitMQ",
    "Amazon SQS": "SQS",
    "amazon-sqs": "SQS",
    "sqs": "SQS",
    "Amazon Kinesis": "Kinesis",
    "amazon-kinesis": "Kinesis",
    "kinesis": "Kinesis",
    "Google Cloud Pub/Sub": "Cloud Pub/Sub",
    "google cloud pub/sub": "Cloud Pub/Sub",
    "Azure Service Bus": "Azure Service Bus",
    "azure service bus": "Azure Service Bus",

    # --- Security ---
    "CrowdStrike": "CrowdStrike",
    "crowdstrike": "CrowdStrike",
    "Palo Alto": "Palo Alto",
    "palo alto": "Palo Alto",
    "Snyk": "Snyk",
    "snyk": "Snyk",
    "Aqua": "Aqua",
    "aqua": "Aqua",
    "Twistlock": "Twistlock",
    "twistlock": "Twistlock",
    "Prisma Cloud": "Prisma Cloud",
    "prisma cloud": "Prisma Cloud",
    "Qualys": "Qualys",
    "qualys": "Qualys",
    "Tenable": "Tenable",
    "tenable": "Tenable",
    "Rapid7": "Rapid7",
    "rapid7": "Rapid7",
    "Wiz": "Wiz",
    "wiz": "Wiz",
    "Orca": "Orca",
    "orca": "Orca",
    "Lacework": "Lacework",
    "lacework": "Lacework",
    "Veracode": "Veracode",
    "veracode": "Veracode",
    "Checkmarx": "Checkmarx",
    "checkmarx": "Checkmarx",

    # --- Languages / Frameworks ---
    "Java": "Java",
    "java": "Java",
    "Python": "Python",
    "python": "Python",
    "Node.js": "Node.js",
    "node.js": "Node.js",
    "nodejs": "Node.js",
    "node-js": "Node.js",
    "Go": "Go",
    "go": "Go",
    "golang": "Go",
    "go-lang": "Go",
    "Ruby": "Ruby",
    "ruby": "Ruby",
    ".NET": ".NET",
    ".net": ".NET",
    "dotnet": ".NET",
    "React": "React",
    "react": "React",
    "TypeScript": "TypeScript",
    "typescript": "TypeScript",
    "Swift": "Swift",
    "swift": "Swift",
    "Kotlin": "Kotlin",
    "kotlin": "Kotlin",
    "C#": "C#",
    "c#": "C#",
    "Scala": "Scala",
    "scala": "Scala",
    "Rust": "Rust",
    "rust": "Rust",
    "PHP": "PHP",
    "php": "PHP",

    # --- Data Platforms ---
    "Databricks": "Databricks",
    "databricks": "Databricks",
    "Snowflake": "Snowflake",
    "snowflake": "Snowflake",
    "BigQuery": "BigQuery",
    "bigquery": "BigQuery",
    "GCP BigQuery": "BigQuery",
    "gcp-bigquery": "BigQuery",
    "gcp bigquery": "BigQuery",
    "Apache Spark": "Apache Spark",
    "apache-spark": "Apache Spark",
    "spark": "Apache Spark",
    "Apache Airflow": "Airflow",
    "apache-airflow": "Airflow",
    "airflow": "Airflow",
    "dbt": "dbt",
    "Tableau": "Tableau",
    "tableau": "Tableau",
    "Power BI": "Power BI",
    "power bi": "Power BI",
    "microsoft power bi": "Power BI",
    "Looker": "Looker",
    "looker": "Looker",

    # --- Feature Flags ---
    "LaunchDarkly": "LaunchDarkly",
    "launchdarkly": "LaunchDarkly",
    "launch darkly": "LaunchDarkly",
    "Optimizely": "Optimizely",
    "optimizely": "Optimizely",
    "Split": "Split",
    "split": "Split",
    "split.io": "Split",
    "split-io": "Split",

    # --- Serverless ---
    "AWS Lambda": "AWS Lambda",
    "aws-lambda": "AWS Lambda",
    "lambda": "AWS Lambda",
    "Azure Functions": "Azure Functions",
    "azure functions": "Azure Functions",
    "Google Cloud Functions": "Cloud Functions",
    "google cloud functions": "Cloud Functions",

    # --- Networking / CDN ---
    "Cloudflare": "Cloudflare",
    "cloudflare": "Cloudflare",
    "Nginx": "Nginx",
    "nginx": "Nginx",
    "Apache HTTPD": "Apache HTTPD",
    "apache httpd": "Apache HTTPD",
    "apache-httpd": "Apache HTTPD",
    "Envoy": "Envoy",
    "envoy": "Envoy",
    "HAProxy": "HAProxy",
    "haproxy": "HAProxy",
    "Kong": "Kong",
    "kong": "Kong",
    "Traefik": "Traefik",
    "traefik": "Traefik",

    # --- Managed Kubernetes ---
    "EKS": "EKS",
    "eks": "EKS",
    "Amazon EKS": "EKS",
    "GKE": "GKE",
    "gke": "GKE",
    "Google Kubernetes Engine": "GKE",
    "AKS": "AKS",
    "aks": "AKS",
    "Azure Kubernetes Service": "AKS",

    # --- Other commonly seen ---
    "Amazon RDS": "Amazon RDS",
    "amazon-rds": "Amazon RDS",
    "rds": "Amazon RDS",
    "Azure DevOps": "Azure DevOps",
    "azure-devops": "Azure DevOps",
    "azure devops": "Azure DevOps",
}

# Pre-build a case-insensitive lookup for fast path
_ALIASES_LOWER: dict[str, str] = {k.lower(): v for k, v in TECH_NAME_ALIASES.items()}


def normalize_tech_name(raw_name: str) -> str:
    """Normalize a technology name to its canonical form.

    1. Direct lookup in the alias map (case-insensitive).
    2. Try matching after stripping hyphens/spaces.
    3. Partial substring match (both directions).
    4. Return original if nothing matches.
    """
    if not raw_name:
        return raw_name

    lower = raw_name.lower().strip()

    # Fast path — exact case-insensitive match
    if lower in _ALIASES_LOWER:
        return _ALIASES_LOWER[lower]

    # Try slugified/de-slugified variants
    for variant in (
        lower.replace("-", " "),
        lower.replace(" ", "-"),
        lower.replace("-", "").replace(" ", ""),
    ):
        if variant in _ALIASES_LOWER:
            return _ALIASES_LOWER[variant]

    # Partial substring match (expensive — only for edge cases)
    for alias_lower, canonical in _ALIASES_LOWER.items():
        if alias_lower in lower or lower in alias_lower:
            return canonical

    return raw_name


# ---------------------------------------------------------------------------
# Technology categories
# ---------------------------------------------------------------------------

TECH_CATEGORIES: dict[str, str] = {
    # Observability / Monitoring
    "Datadog": "observability", "New Relic": "observability", "Dynatrace": "observability",
    "AppDynamics": "observability", "Splunk": "observability", "ELK": "observability",
    "Grafana": "observability", "Prometheus": "observability", "Nagios": "observability",
    "Zabbix": "observability", "Sumo Logic": "observability", "PagerDuty": "observability",
    "OpsGenie": "observability", "CloudWatch": "observability", "Azure Monitor": "observability",
    "GCP Cloud Monitoring": "observability", "SignalFx": "observability",
    "Honeycomb": "observability", "Lightstep": "observability", "Sentry": "observability",
    "Instana": "observability", "Catchpoint": "observability", "ThousandEyes": "observability",
    "OpenTelemetry": "observability", "Site24x7": "observability", "Pingdom": "observability",
    "ManageEngine": "observability", "SolarWinds": "observability",
    "LogicMonitor": "observability", "Icinga": "observability", "VictorOps": "observability",

    # Cloud
    "AWS": "cloud", "GCP": "cloud", "Azure": "cloud",

    # Infrastructure
    "Docker": "infra", "Kubernetes": "infra", "Terraform": "infra", "Ansible": "infra",
    "Jenkins": "infra", "Helm": "infra", "Istio": "infra", "Consul": "infra",
    "Vault": "infra", "Nomad": "infra", "Puppet": "infra", "Chef": "infra",
    "Salt": "infra", "Flux": "infra",

    # Security
    "CrowdStrike": "security", "Palo Alto": "security", "Snyk": "security",
    "Aqua": "security", "Twistlock": "security", "Prisma Cloud": "security",
    "Qualys": "security", "Tenable": "security", "Rapid7": "security",
    "Wiz": "security", "Orca": "security", "Lacework": "security",
    "Veracode": "security", "Checkmarx": "security",

    # Databases
    "PostgreSQL": "databases", "MySQL": "databases", "MongoDB": "databases",
    "Redis": "databases", "SQL Server": "databases", "Oracle DB": "databases",
    "DB2": "databases", "Cassandra": "databases", "CouchDB": "databases",
    "Couchbase": "databases", "MariaDB": "databases", "DynamoDB": "databases",
    "CosmosDB": "databases", "Amazon RDS": "databases",

    # Message Queues / Streaming
    "Kafka": "message_queues", "Kafka Connect": "message_queues",
    "RabbitMQ": "message_queues", "SQS": "message_queues",
    "Kinesis": "message_queues", "Cloud Pub/Sub": "message_queues",
    "Azure Service Bus": "message_queues",

    # Languages / Frameworks
    "Java": "languages", "Python": "languages", "Node.js": "languages",
    "Go": "languages", "Ruby": "languages", ".NET": "languages",
    "React": "languages", "TypeScript": "languages", "Swift": "languages",
    "Kotlin": "languages", "C#": "languages", "Scala": "languages",
    "Rust": "languages", "PHP": "languages",

    # Data Platforms
    "Databricks": "data_platforms", "Snowflake": "data_platforms",
    "BigQuery": "data_platforms", "Apache Spark": "data_platforms",
    "Airflow": "data_platforms", "dbt": "data_platforms",
    "Tableau": "data_platforms", "Power BI": "data_platforms",
    "Looker": "data_platforms",

    # CI/CD
    "CircleCI": "cicd", "GitHub Actions": "cicd", "GitLab": "cicd",
    "ArgoCD": "cicd", "Artifactory": "cicd", "Spinnaker": "cicd",
    "Harness": "cicd",

    # Feature Flags
    "LaunchDarkly": "feature_flags", "Optimizely": "feature_flags",
    "Split": "feature_flags",

    # Serverless
    "AWS Lambda": "serverless", "Azure Functions": "serverless",
    "Cloud Functions": "serverless",

    # Networking
    "Cloudflare": "networking", "Nginx": "networking",
    "Apache HTTPD": "networking", "Envoy": "networking",
    "HAProxy": "networking", "Kong": "networking", "Traefik": "networking",

    # Managed Kubernetes (maps to infra)
    "EKS": "infra", "GKE": "infra", "AKS": "infra",

    # Azure DevOps -> cicd
    "Azure DevOps": "cicd",
}


def categorize_tech(canonical_name: str) -> str | None:
    """Return the category for a canonical technology name, or None."""
    return TECH_CATEGORIES.get(canonical_name)


# ---------------------------------------------------------------------------
# Dependency inference: if X is confirmed, Y is at least "likely"
# ---------------------------------------------------------------------------

TECH_DEPENDENCIES: dict[str, list[str]] = {
    "CloudWatch": ["AWS"],
    "AWS Lambda": ["AWS"],
    "Amazon RDS": ["AWS"],
    "EKS": ["AWS", "Kubernetes"],
    "SQS": ["AWS"],
    "Kinesis": ["AWS"],
    "DynamoDB": ["AWS"],
    "Azure Monitor": ["Azure"],
    "Azure DevOps": ["Azure"],
    "Azure Functions": ["Azure"],
    "Azure Service Bus": ["Azure"],
    "AKS": ["Azure", "Kubernetes"],
    "CosmosDB": ["Azure"],
    "BigQuery": ["GCP"],
    "GCP Cloud Monitoring": ["GCP"],
    "GKE": ["GCP", "Kubernetes"],
    "Cloud Functions": ["GCP"],
    "Cloud Pub/Sub": ["GCP"],
    "Istio": ["Kubernetes"],
    "Helm": ["Kubernetes"],
    "ArgoCD": ["Kubernetes"],
    "Flux": ["Kubernetes"],
    "Kafka Connect": ["Kafka"],
    "Databricks": ["Apache Spark"],
}


# ---------------------------------------------------------------------------
# Competitive tools — canonical names Datadog can displace
# ---------------------------------------------------------------------------

COMPETITIVE_TOOLS: set[str] = {
    "Splunk", "New Relic", "Dynatrace", "AppDynamics", "ELK",
    "Grafana", "Prometheus", "Nagios", "Zabbix", "Sumo Logic",
    "PagerDuty", "CloudWatch", "Azure Monitor", "GCP Cloud Monitoring",
    "SignalFx", "Honeycomb", "Lightstep", "Sentry", "Instana",
    "LogicMonitor", "SolarWinds", "ManageEngine", "Catchpoint",
    "ThousandEyes", "OpenTelemetry", "Site24x7", "Pingdom",
    "Icinga", "VictorOps",
}
