import {
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Tooltip,
  Typography,
} from "@mui/material";
import Link from "next/link";

import { MenuItem } from "../../../../menuItems/types";

// ==============================|| NAVIGATION - LIST ITEM ||============================== //

function NavItem({
  item,
  level,
  isSelected,
}: {
  level: number;
  item: MenuItem;
  isSelected: boolean;
}) {
  const Icon = item.icon;
  const textColor = "text.primary";
  const iconSelectedColor = "primary.main";
  const description = item.disabled
    ? `Coming Soon: ${item.description}`
    : item.description;

  return (
    <Tooltip title={description} placement="right" arrow>
      <span>
        <ListItemButton
          href={item.url}
          disabled={item.disabled}
          target={item.external ? "_blank" : "_self"}
          rel={item.external ? "noopener noreferrer" : undefined}
          component={item.external ? "a" : Link}
          selected={isSelected}
          aria-current={isSelected ? "page" : undefined}
          sx={{
            minHeight: 36,
            borderRadius: 1,
            pl: level,
            pr: 1,
            py: 0.5,
            "&:hover": { bgcolor: "primary.lighter" },
            "&.Mui-selected": {
              bgcolor: "primary.lighter",
              color: iconSelectedColor,
              "&:hover": { bgcolor: "primary.lighter" },
            },
            "&.Mui-focusVisible": {
              outline: "2px solid",
              outlineColor: "primary.main",
              outlineOffset: -2,
            },
          }}
        >
          <ListItemIcon
            sx={{
              minWidth: 28,
              color: isSelected ? iconSelectedColor : textColor,
              "& svg": { fontSize: 20 },
            }}
          >
            <Icon />
          </ListItemIcon>

          <ListItemText
            primary={
              <Typography
                variant="body2"
                sx={{ color: isSelected ? iconSelectedColor : textColor }}
              >
                {item.title}
              </Typography>
            }
          />
        </ListItemButton>
      </span>
    </Tooltip>
  );
}

export default NavItem;
