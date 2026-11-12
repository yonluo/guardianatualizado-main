
-- CRIAR BANCO

CREATE DATABASE IF NOT EXISTS angel_guardian
DEFAULT CHARACTER SET utf8mb4
DEFAULT COLLATE utf8mb4_general_ci;

USE angel_guardian;


-- USUÁRIOS (users)

CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(150) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    cpf VARCHAR(30),
    telefone VARCHAR(40),
    birthdate DATE NULL,
    avatar_url VARCHAR(255),
    bio VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT NULL
) ENGINE=InnoDB;


-- TIPOS DE ALERTA (alert_types)

CREATE TABLE IF NOT EXISTS alert_types (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    color VARCHAR(20),
    icon VARCHAR(50),
    UNIQUE KEY uq_alert_types_name (name)
) ENGINE=InnoDB;

-- ALERTAS (alerts)

CREATE TABLE IF NOT EXISTS alerts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    alert_type_id INT NOT NULL,
    title VARCHAR(150) NOT NULL,
    description TEXT NOT NULL,
    status ENUM('active','resolved','hidden') DEFAULT 'active',
    is_urgent BOOLEAN DEFAULT FALSE,

    latitude DECIMAL(10,8),
    longitude DECIMAL(11,8),
    address VARCHAR(255),
    neighborhood VARCHAR(100),
    city VARCHAR(100),

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT NULL,

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (alert_type_id) REFERENCES alert_types(id),

    INDEX (created_at),
    INDEX (status),
    INDEX (latitude, longitude)
) ENGINE=InnoDB;


-- MÍDIA DO ALERTA (alert_media)

CREATE TABLE IF NOT EXISTS alert_media (
    id INT AUTO_INCREMENT PRIMARY KEY,
    alert_id INT NOT NULL,
    media_type ENUM('image','video') DEFAULT 'image',
    media_url VARCHAR(255) NOT NULL,
    caption VARCHAR(150),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- COMENTÁRIOS (comments)

CREATE TABLE IF NOT EXISTS comments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    alert_id INT NOT NULL,
    user_id INT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,

    INDEX (alert_id)
) ENGINE=InnoDB;

-- CURTIDAS (likes)

CREATE TABLE IF NOT EXISTS likes (
    user_id INT NOT NULL,
    alert_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (user_id, alert_id),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE
) ENGINE=InnoDB;


-- COMPARTILHAMENTOS (shares)

CREATE TABLE IF NOT EXISTS shares (
    id INT AUTO_INCREMENT PRIMARY KEY,
    alert_id INT NOT NULL,
    user_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;


-- FAVORITOS (saved_alerts)

CREATE TABLE IF NOT EXISTS saved_alerts (
    user_id INT NOT NULL,
    alert_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (user_id, alert_id),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE
) ENGINE=InnoDB;


-- NOTIFICAÇÕES (notifications)

CREATE TABLE IF NOT EXISTS notifications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    title VARCHAR(150) NOT NULL,
    message TEXT NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX (user_id, is_read)
) ENGINE=InnoDB;


-- DENÚNCIAS (reports)

CREATE TABLE IF NOT EXISTS reports (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    alert_id INT NOT NULL,
    reason VARCHAR(255) NOT NULL,
    details TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Tabelas usadas pelo Guardian além do modelo legado de alertas.
CREATE TABLE IF NOT EXISTS community_posts (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    category VARCHAR(40) NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX ix_community_posts_created (created_at, id),
    INDEX ix_community_posts_user (user_id, created_at),
    CONSTRAINT fk_community_posts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS community_post_media (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    post_id BIGINT NOT NULL,
    media_type VARCHAR(10) NOT NULL,
    mime_type VARCHAR(80) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    data LONGBLOB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX ix_community_post_media_post (post_id, id),
    CONSTRAINT fk_community_post_media_post FOREIGN KEY (post_id) REFERENCES community_posts(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS community_stories (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    category VARCHAR(40) NOT NULL,
    content VARCHAR(500) NOT NULL,
    media_type VARCHAR(10) NULL,
    mime_type VARCHAR(80) NULL,
    file_name VARCHAR(255) NULL,
    media_data LONGBLOB NULL,
    is_alert BOOLEAN NOT NULL DEFAULT FALSE,
    encrypted_report_number TEXT NULL,
    report_date DATE NULL,
    report_mime_type VARCHAR(80) NULL,
    report_file_name VARCHAR(255) NULL,
    encrypted_report_evidence LONGTEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at BIGINT NOT NULL,
    INDEX ix_community_stories_expiry (expires_at, created_at),
    INDEX ix_community_stories_user (user_id, created_at),
    CONSTRAINT fk_community_stories_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS community_post_comments (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    post_id BIGINT NOT NULL,
    user_id INT NOT NULL,
    content VARCHAR(1000) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX ix_community_post_comments_post (post_id, created_at, id),
    CONSTRAINT fk_community_post_comments_post FOREIGN KEY (post_id) REFERENCES community_posts(id) ON DELETE CASCADE,
    CONSTRAINT fk_community_post_comments_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS user_settings (
    user_id INT NOT NULL,
    setting_key VARCHAR(64) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, setting_key),
    CONSTRAINT fk_user_settings_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS contacts (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    requester_id INT NOT NULL,
    recipient_id INT NOT NULL,
    status ENUM('pending', 'accepted', 'rejected') NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_contacts_pair_directional (requester_id, recipient_id),
    INDEX ix_contacts_recipient_status (recipient_id, status),
    CONSTRAINT fk_contacts_requester FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_contacts_recipient FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS contact_groups (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    owner_id INT NOT NULL,
    name VARCHAR(100) NOT NULL,
    description VARCHAR(255) NOT NULL DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX ix_contact_groups_owner_created (owner_id, created_at),
    CONSTRAINT fk_contact_groups_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS contact_group_members (
    group_id BIGINT NOT NULL,
    user_id INT NOT NULL,
    PRIMARY KEY (group_id, user_id),
    INDEX ix_contact_group_members_user (user_id, group_id),
    CONSTRAINT fk_contact_group_members_group FOREIGN KEY (group_id) REFERENCES contact_groups(id) ON DELETE CASCADE,
    CONSTRAINT fk_contact_group_members_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS conversations (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    type ENUM('direct', 'group') NOT NULL,
    group_id BIGINT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_conversations_group (group_id),
    CONSTRAINT fk_conversations_group FOREIGN KEY (group_id) REFERENCES contact_groups(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id BIGINT NOT NULL,
    user_id INT NOT NULL,
    PRIMARY KEY (conversation_id, user_id),
    INDEX ix_conversation_members_user (user_id, conversation_id),
    CONSTRAINT fk_conversation_members_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    CONSTRAINT fk_conversation_members_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS messages (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    conversation_id BIGINT NOT NULL,
    sender_id INT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX ix_messages_conversation_created (conversation_id, created_at, id),
    CONSTRAINT fk_messages_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    CONSTRAINT fk_messages_sender FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS message_media (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    message_id BIGINT NOT NULL,
    mime_type VARCHAR(80) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    data LONGBLOB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_message_media_message FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS managed_cameras (
    id VARCHAR(36) PRIMARY KEY,
    owner_id INT NOT NULL,
    name VARCHAR(80) NOT NULL,
    location VARCHAR(180) NOT NULL,
    latitude DOUBLE NULL,
    longitude DOUBLE NULL,
    encrypted_report_number TEXT NOT NULL,
    report_date DATE NOT NULL,
    encrypted_source TEXT NOT NULL,
    path_name VARCHAR(80) NOT NULL UNIQUE,
    is_public BOOLEAN NOT NULL DEFAULT FALSE,
    release_status VARCHAR(16) NOT NULL DEFAULT 'pending',
    review_by INT NULL,
    reviewed_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX ix_managed_cameras_owner_created (owner_id, created_at),
    INDEX ix_managed_cameras_public (release_status, is_public, latitude, longitude),
    CONSTRAINT fk_managed_cameras_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_managed_cameras_reviewer FOREIGN KEY (review_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS camera_report_evidence (
    camera_id VARCHAR(36) PRIMARY KEY,
    mime_type VARCHAR(80) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    encrypted_data LONGTEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_camera_report_evidence_camera FOREIGN KEY (camera_id) REFERENCES managed_cameras(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS camera_access_requests (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    camera_id VARCHAR(36) NOT NULL,
    requester_id INT NOT NULL,
    owner_id INT NOT NULL,
    status ENUM('pending', 'approved', 'rejected', 'revoked') NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    decided_at TIMESTAMP NULL,
    UNIQUE KEY uq_camera_access_request (camera_id, requester_id),
    INDEX ix_camera_access_owner_status (owner_id, status, created_at),
    INDEX ix_camera_access_requester_status (requester_id, status),
    CONSTRAINT fk_camera_access_camera FOREIGN KEY (camera_id) REFERENCES managed_cameras(id) ON DELETE CASCADE,
    CONSTRAINT fk_camera_access_requester FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_camera_access_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS site_feedback (
    user_id INT PRIMARY KEY,
    comment VARCHAR(500) NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_site_feedback_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(64) PRIMARY KEY,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Seeds somente de catálogo. Os nomes únicos tornam a reaplicação idempotente.
INSERT INTO alert_types (name, color, icon) VALUES
('Assalto', '#E53935', 'alert'),
('Furto', '#FBC02D', 'package'),
('Suspeito', '#FB8C00', 'user'),
('Emergência', '#D32F2F', 'warning')
ON DUPLICATE KEY UPDATE color = VALUES(color), icon = VALUES(icon);
