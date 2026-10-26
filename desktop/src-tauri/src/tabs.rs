//! Which tabs the in-app browser holds for each chat, and which one is on screen. No webviews
//! here: `pane` builds, shows, hides and drops them to match.

use std::collections::HashMap;

use tauri::Url;

/// How many chats keep their pages loaded. Older chats keep only their tabs' addresses and load
/// them again when you come back.
pub const LIVE_CHATS: usize = 3;

#[derive(Clone, Debug, PartialEq)]
pub struct Tab {
    pub id: u64,
    /// None for a new tab that hasn't been anywhere yet.
    pub url: Option<Url>,
    pub title: Option<String>,
    /// Whether a webview holds this tab right now.
    pub live: bool,
}

impl Tab {
    /// What the tab strip calls it: the page's title, else its host.
    pub fn name(&self) -> String {
        if let Some(title) = self.title.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            return title.to_string();
        }
        self.url.as_ref().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_else(|| "New tab".into())
    }
}

#[derive(Default)]
struct Chat {
    tabs: Vec<Tab>,
    active: usize,
    open: bool,
    used: u64,
}

/// Every chat's browser. `None` is everything that isn't a chat (the list, settings).
#[derive(Default)]
pub struct Tabs {
    chats: HashMap<Option<String>, Chat>,
    current: Option<String>,
    next: u64,
    clock: u64,
}

impl Tabs {
    fn chat(&mut self) -> &mut Chat {
        self.clock += 1;
        let clock = self.clock;
        let chat = self.chats.entry(self.current.clone()).or_default();
        chat.used = clock;
        chat
    }

    /// Moves to chat `to`; false when it's already the one on screen.
    pub fn switch(&mut self, to: Option<String>) -> bool {
        if to == self.current {
            return false;
        }
        self.current = to;
        self.chat();
        true
    }

    fn push(&mut self, url: Option<Url>) -> u64 {
        self.next += 1;
        let id = self.next;
        let chat = self.chat();
        chat.tabs.push(Tab { id, url, title: None, live: false });
        chat.active = chat.tabs.len() - 1;
        chat.open = true;
        id
    }

    /// A link clicked in the chat: a new tab in this chat's browser, or the tab already showing it.
    pub fn open_link(&mut self, url: Url) -> u64 {
        let chat = self.chat();
        if let Some(i) = chat.tabs.iter().position(|t| t.url.as_ref() == Some(&url)) {
            chat.active = i;
            chat.open = true;
            return chat.tabs[i].id;
        }
        self.push(Some(url))
    }

    pub fn new_tab(&mut self) -> u64 {
        self.push(None)
    }

    pub fn select(&mut self, id: u64) {
        let chat = self.chat();
        if let Some(i) = chat.tabs.iter().position(|t| t.id == id) {
            chat.active = i;
        }
    }

    /// Closes tab `id` in the chat on screen; the browser closes with its last tab.
    pub fn close_tab(&mut self, id: u64) -> bool {
        let chat = self.chat();
        let Some(i) = chat.tabs.iter().position(|t| t.id == id) else { return false };
        chat.tabs.remove(i);
        if i < chat.active || chat.active >= chat.tabs.len() {
            chat.active = chat.active.saturating_sub(1);
        }
        if chat.tabs.is_empty() {
            chat.open = false;
        }
        true
    }

    /// The header's browser button: puts this chat's browser away, or brings it back (with a new
    /// tab when it has none).
    pub fn toggle(&mut self) {
        let chat = self.chat();
        if chat.tabs.is_empty() {
            self.new_tab();
        } else {
            chat.open = !chat.open;
        }
    }

    /// Puts this chat's browser away, keeping its tabs.
    pub fn hide(&mut self) {
        self.chat().open = false;
    }

    pub fn is_open(&self) -> bool {
        self.chats.get(&self.current).is_some_and(|c| c.open && !c.tabs.is_empty())
    }

    /// The tab on screen, if this chat's browser is open.
    pub fn shown(&self) -> Option<&Tab> {
        let chat = self.chats.get(&self.current).filter(|c| c.open)?;
        chat.tabs.get(chat.active)
    }

    /// This chat's tabs, for the tab strip.
    pub fn strip(&self) -> &[Tab] {
        self.chats.get(&self.current).map_or(&[], |c| &c.tabs)
    }

    pub fn tab(&mut self, id: u64) -> Option<&mut Tab> {
        self.chats.values_mut().flat_map(|c| c.tabs.iter_mut()).find(|t| t.id == id)
    }

    /// Unloads the pages of every chat but the `keep` most recently used (the one on screen is
    /// always kept). Returns the tabs whose webviews should go.
    pub fn discard(&mut self, keep: usize) -> Vec<u64> {
        let mut chats: Vec<_> = self.chats.iter_mut().filter(|(_, c)| c.tabs.iter().any(|t| t.live)).collect();
        let current = self.current.clone();
        chats.sort_by_key(|(key, c)| (**key != current, std::cmp::Reverse(c.used)));
        let mut gone = Vec::new();
        for (_, chat) in chats.into_iter().skip(keep.max(1)) {
            for tab in chat.tabs.iter_mut().filter(|t| t.live) {
                tab.live = false;
                gone.push(tab.id);
            }
        }
        gone
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    fn chat(tabs: &mut Tabs, id: &str) {
        tabs.switch(Some(id.into()));
    }

    #[test]
    fn each_chat_has_its_own_browser() {
        let mut tabs = Tabs::default();
        chat(&mut tabs, "a");
        let a = tabs.open_link(url("https://one.example/"));
        chat(&mut tabs, "b");
        assert_eq!(tabs.shown(), None, "b has opened nothing");
        let b = tabs.open_link(url("https://two.example/"));
        assert_ne!(a, b);
        chat(&mut tabs, "a");
        assert_eq!(tabs.shown().map(|t| t.id), Some(a), "a gets its own tab back, not b's");
        assert_eq!(tabs.strip().len(), 1);
    }

    #[test]
    fn links_open_new_tabs_and_reuse_one_already_showing_the_page() {
        let mut tabs = Tabs::default();
        chat(&mut tabs, "a");
        let one = tabs.open_link(url("https://one.example/"));
        let two = tabs.open_link(url("https://two.example/"));
        assert_eq!(tabs.strip().len(), 2);
        assert_eq!(tabs.shown().map(|t| t.id), Some(two));
        assert_eq!(tabs.open_link(url("https://one.example/")), one);
        assert_eq!(tabs.strip().len(), 2, "no duplicate tab");
        assert_eq!(tabs.shown().map(|t| t.id), Some(one));
    }

    #[test]
    fn closing_tabs_moves_to_a_neighbour_and_the_last_one_closes_the_browser() {
        let mut tabs = Tabs::default();
        chat(&mut tabs, "a");
        let one = tabs.open_link(url("https://one.example/"));
        let two = tabs.new_tab();
        let three = tabs.new_tab();
        tabs.select(two);
        assert!(tabs.close_tab(two));
        assert_eq!(tabs.shown().map(|t| t.id), Some(three));
        assert!(tabs.close_tab(three));
        assert_eq!(tabs.shown().map(|t| t.id), Some(one));
        assert!(tabs.close_tab(one));
        assert!(!tabs.is_open());
        assert_eq!(tabs.shown(), None);
    }

    #[test]
    fn the_browser_button_hides_and_brings_back_the_same_tabs() {
        let mut tabs = Tabs::default();
        chat(&mut tabs, "a");
        tabs.toggle();
        let blank = tabs.shown().cloned().expect("a new tab");
        assert_eq!(blank.url, None);
        assert_eq!(blank.name(), "New tab");
        tabs.toggle();
        assert!(!tabs.is_open());
        tabs.toggle();
        assert_eq!(tabs.shown().map(|t| t.id), Some(blank.id), "same tab, no second blank one");
        assert_eq!(tabs.strip().len(), 1);
    }

    #[test]
    fn a_chat_left_with_its_browser_closed_stays_closed() {
        let mut tabs = Tabs::default();
        chat(&mut tabs, "a");
        tabs.open_link(url("https://one.example/"));
        tabs.hide();
        chat(&mut tabs, "b");
        chat(&mut tabs, "a");
        assert!(!tabs.is_open());
        assert_eq!(tabs.strip().len(), 1, "tabs kept");
    }

    #[test]
    fn only_recent_chats_keep_their_pages_loaded() {
        let mut tabs = Tabs::default();
        let mut ids = Vec::new();
        for name in ["a", "b", "c", "d"] {
            chat(&mut tabs, name);
            let id = tabs.open_link(url(&format!("https://{name}.example/")));
            tabs.tab(id).unwrap().live = true;
            ids.push(id);
        }
        assert_eq!(tabs.discard(LIVE_CHATS), vec![ids[0]], "a is the oldest");
        assert_eq!(tabs.discard(LIVE_CHATS), Vec::<u64>::new(), "already unloaded");
        chat(&mut tabs, "a");
        let back = tabs.shown().cloned().unwrap();
        assert!(!back.live, "a's page loads again");
        assert_eq!(back.url, Some(url("https://a.example/")));
    }

    #[test]
    fn the_chat_on_screen_is_never_unloaded() {
        let mut tabs = Tabs::default();
        chat(&mut tabs, "a");
        let id = tabs.open_link(url("https://a.example/"));
        tabs.tab(id).unwrap().live = true;
        assert!(tabs.discard(0).is_empty());
    }

    #[test]
    fn tabs_are_named_by_title_then_host() {
        let mut tab = Tab { id: 1, url: Some(url("https://docs.example/a")), title: Some("  ".into()), live: true };
        assert_eq!(tab.name(), "docs.example");
        tab.title = Some("Docs".into());
        assert_eq!(tab.name(), "Docs");
    }
}
